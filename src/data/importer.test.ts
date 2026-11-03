import { afterEach, describe, expect, it } from "vitest";
import { catalog, guideWindow, programmesBetween } from "../../scripts/test-streams/catalog.mjs";
import { m3u, xmltv } from "../../scripts/test-streams/playlist.mjs";
import { DAY, deleteDb, openDb, readChannels, readGuide, readGuideChannels, readImport } from "./db";
import { importSource } from "./importClient";
import { runImport, type ImportProgress } from "./importer";

const BASE = "http://test.local";
const HOUR = 3_600_000;
const DB = "tiviplayer-test";
const PLAYLIST = `${BASE}/playlist.m3u`;
const GUIDE = `${BASE}/guide.xml.gz`;

type Files = Record<string, string | Uint8Array<ArrayBuffer> | undefined>;

const gzip = async (text: string) =>
  new Uint8Array(
    await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );

// A fetch that serves fixed files.
const serve =
  (files: Files): typeof fetch =>
  input => {
    const body = files[input instanceof Request ? input.url : input.toString()];
    return Promise.resolve(body === undefined ? new Response("", { status: 404 }) : new Response(body));
  };

// The test server's playlist and guide, for the first `playlistCount` of
// `count` channels; the guide has all of them.
const source = async (count: number, playlistCount = count) => {
  const { channels } = catalog(count);
  const window = guideWindow(3);
  const files: Files = {
    [PLAYLIST]: m3u({ base: BASE, channels: channels.slice(0, playlistCount), guideUrl: GUIDE }),
    [GUIDE]: await gzip([...xmltv({ base: BASE, channels, window })].join("")),
  };
  return { channels, window, files };
};

const blobUrl = (body: Files[string]) => URL.createObjectURL(new Blob([body ?? ""]));

afterEach(async () => {
  await deleteDb(DB);
});

describe("runImport", () => {
  it("imports a playlist and its gzipped guide", async () => {
    const { channels, window, files } = await source(120);
    const progress: ImportProgress[] = [];
    const result = await runImport(
      { source: "test", playlistUrl: PLAYLIST },
      { dbName: DB, fetch: serve(files), onProgress: p => progress.push(p) },
    );
    expect(result).toMatchObject({
      status: "done",
      channels: 120,
      guideTrimmed: false,
      unmatchedProgrammes: 0,
    });
    expect(result.guideUrls).toEqual([GUIDE]);
    // Only programmes starting before the first day kept are left out: at
    // most one per channel, the one on air at midnight.
    expect(result.skippedProgrammes).toBeLessThanOrEqual(result.guideChannels);
    expect(result.programmes + result.skippedProgrammes).toBe(result.programmesRead);
    expect(progress[progress.length - 1]).toMatchObject({
      stage: "guide",
      programmes: result.programmesRead,
    });

    const db = await openDb(DB);
    expect(await readImport(db, "test")).toMatchObject({ status: "done", channels: 120 });
    expect((await readChannels(db, "test")).map(c => c.name)).toEqual(channels.map(c => c.name));
    expect(await readGuideChannels(db, "test")).toHaveLength(result.guideChannels);

    // Each channel's guide reads back as generated, across midnight too.
    const from = window.start + 30 * HOUR;
    const to = from + 6 * HOUR;
    for (const channel of channels.filter(c => c.guideId).slice(0, 20)) {
      const list = await readGuide(db, "test", channel.guideId, from, to);
      const expected = programmesBetween(channel, window, from, to);
      expect(list.map(p => [p.start, p.stop, p.title, p.description])).toEqual(
        expected.map(p => [p.start, p.stop, p.title, p.description]),
      );
    }
    db.close();
  });

  it("keeps only the guide channels the playlist uses", async () => {
    const { channels, window, files } = await source(100, 40);
    const result = await runImport(
      { source: "test", playlistUrl: PLAYLIST },
      { dbName: DB, fetch: serve(files) },
    );
    expect(result.channels).toBe(40);
    expect(result.unmatchedProgrammes).toBeGreaterThan(0);
    const db = await openDb(DB);
    expect(await readGuide(db, "test", channels[70].guideId, window.start, window.end)).toEqual([]);
    db.close();
  });

  it("refreshes in place, and keeps the old data if a refresh fails", async () => {
    const { channels, window, files } = await source(30);
    const request = { source: "test", playlistUrl: PLAYLIST };
    await runImport(request, { dbName: DB, fetch: serve(files) });
    const guideId = channels[25].guideId;
    let db = await openDb(DB);
    expect((await readGuide(db, "test", guideId, window.start, window.end)).length).toBeGreaterThan(0);
    db.close();

    // A failed refresh leaves the data usable, and says it failed, with the
    // counts and time of the import that the data is from.
    db = await openDb(DB);
    const first = await readImport(db, "test");
    db.close();
    await expect(
      runImport(request, { dbName: DB, fetch: serve({ ...files, [GUIDE]: undefined }) }),
    ).rejects.toThrow(/HTTP 404/);
    db = await openDb(DB);
    expect(await readImport(db, "test")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("HTTP 404"),
      channels: 30,
      programmes: first?.programmes,
      lastDoneAt: first?.finishedAt,
    });
    expect(await readChannels(db, "test")).toHaveLength(30);
    db.close();

    // A refresh with fewer channels deletes the ones that went.
    const smaller = await source(30, 20);
    await runImport(request, { dbName: DB, fetch: serve(smaller.files) });
    db = await openDb(DB);
    expect(await readImport(db, "test")).toMatchObject({ status: "done", channels: 20 });
    expect(await readChannels(db, "test")).toHaveLength(20);
    expect(await readGuide(db, "test", guideId, window.start, window.end)).toEqual([]);
    db.close();
  });

  it("drops the farthest days to stay within the budget", async () => {
    const { channels, window, files } = await source(60);
    const budget = 120_000;
    const result = await runImport(
      { source: "test", playlistUrl: PLAYLIST, guideDays: 3, guideBudgetBytes: budget },
      { dbName: DB, fetch: serve(files) },
    );
    expect(result.guideTrimmed).toBe(true);
    expect(result.guideBytes).toBeLessThanOrEqual(budget);
    const firstDay = Math.floor(window.start / DAY);
    expect(result.guideFirstDay).toBe(firstDay);
    expect(result.guideLastDay).toBeLessThan(firstDay + 3);
    expect(result.programmes).toBeLessThan(result.programmesRead);

    // The nearest days are all there; the dropped ones are gone.
    const db = await openDb(DB);
    const channel = channels.find(c => c.guideId);
    const kept = (result.guideLastDay + 1) * DAY;
    const nearest = await readGuide(db, "test", channel.guideId, window.start, kept);
    const expected = programmesBetween(channel, window, window.start, kept);
    expect(nearest.map(p => p.start)).toEqual(
      expected
        .filter(p => p.start >= firstDay * DAY && Math.floor(p.start / DAY) <= result.guideLastDay)
        .map(p => p.start),
    );
    const later = await readGuide(db, "test", channel.guideId, kept + DAY, window.end);
    expect(later.filter(p => p.start >= kept + DAY)).toEqual([]);
    db.close();
  });
});

describe("importSource", () => {
  it("imports in a worker", async () => {
    const { files } = await source(20);
    const result = await importSource({
      source: "worker-test",
      playlistUrl: blobUrl(files[PLAYLIST]),
      guideUrls: [blobUrl(files[GUIDE])],
    });
    expect(result).toMatchObject({ status: "done", channels: 20 });
    expect(result.programmes).toBeGreaterThan(0);
    const db = await openDb();
    expect(await readImport(db, "worker-test")).toMatchObject({ status: "done" });
    db.close();
    await deleteDb();
  });
});
