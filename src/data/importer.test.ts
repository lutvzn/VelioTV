import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog, guideWindow, programmesBetween } from "../../scripts/test-streams/catalog.mjs";
import { m3u, xmltv } from "../../scripts/test-streams/playlist.mjs";
import {
  DAY,
  deleteDb,
  measureGuide,
  openDb,
  readChannels,
  readGuide,
  readGuideChannels,
  readImport,
} from "./db";
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

// The same, in small pieces, as a download comes.
const serveInChunks =
  (files: Files): typeof fetch =>
  async input => {
    const bytes = new Uint8Array(await (await serve(files)(input)).arrayBuffer());
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        for (let at = 0; at < bytes.length; at += 4096) controller.enqueue(bytes.slice(at, at + 4096));
        controller.close();
      },
    });
    return new Response(body);
  };

const blobUrl = (body: Files[string]) => URL.createObjectURL(new Blob([body ?? ""]));

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteDb(DB);
});

// From the `after`th guide write on, writes fail as they do when storage is full.
const fillStorageAfter = (after: number) => {
  // Called with the database as `this` below.
  // oxlint-disable-next-line typescript/unbound-method
  const transaction = IDBDatabase.prototype.transaction;
  let writes = 0;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const opened = transaction.apply(this, args);
    if (args[0] === "guide" && args[1] === "readwrite" && ++writes >= after) {
      const full = new DOMException("Storage is full", "QuotaExceededError");
      Object.defineProperty(opened, "error", { get: () => full });
      queueMicrotask(() => opened.abort());
    }
    return opened;
  });
};

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

  it("keeps as many days before today as the channels' catch-up reaches", async () => {
    // Every tenth test channel has 3 days of catch-up.
    const { window, files } = await source(20);
    const result = await runImport(
      { source: "test", playlistUrl: PLAYLIST },
      { dbName: DB, fetch: serve(files), now: window.start + 2 * DAY },
    );
    expect(result.guideFirstDay).toBe(Math.floor(window.start / DAY) + 2 - 3);
  });

  it("doesn't count catch-up days the guide doesn't have against the budget", async () => {
    // Catch-up keeps 3 days before today; the guide starts the day before.
    // Enough channels, coming in pieces, that the size is predicted midway.
    const { window, files } = await source(300);
    const now = window.start + 2 * DAY;
    const request = { source: "test", playlistUrl: PLAYLIST };
    const whole = await runImport(request, { dbName: DB, fetch: serveInChunks(files), now });
    expect(whole.guideFirstDay).toBeLessThan(Math.floor(window.start / DAY));
    const result = await runImport(
      { ...request, guideBudgetBytes: Math.round(whole.guideBytes * 1.25) },
      { dbName: DB, fetch: serveInChunks(files), now },
    );
    expect(result).toMatchObject({ guideTrimmed: false, programmes: whole.programmes });
    expect(result.guideLastDay).toBe(whole.guideLastDay);
  });

  it("stops storing when not even one day fits the budget", async () => {
    const { files } = await source(300);
    const request = { source: "test", playlistUrl: PLAYLIST, guideDays: 2, guidePastDays: 1 };
    const whole = await runImport(request, { dbName: DB, fetch: serveInChunks(files) });
    const days = whole.guideLastDay - whole.guideFirstDay + 1;
    const budget = Math.round((whole.guideBytes / days) * 0.4);
    const result = await runImport(
      { ...request, source: "small", guideBudgetBytes: budget },
      { dbName: DB, fetch: serveInChunks(files) },
    );
    expect(result).toMatchObject({ status: "done", guideTrimmed: true });
    expect(result.guideBytes).toBeLessThanOrEqual(budget);
    expect(result.programmes).toBeGreaterThan(0);
  });

  it("drops the farthest days to stay within the budget", async () => {
    const { channels, window, files } = await source(60);
    const budget = 120_000;
    const result = await runImport(
      { source: "test", playlistUrl: PLAYLIST, guideDays: 3, guidePastDays: 1, guideBudgetBytes: budget },
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

describe("full storage", () => {
  it("keeps the old guide of the channels a refresh didn't reach", async () => {
    const { channels, window, files } = await source(300);
    const request = { source: "test", playlistUrl: PLAYLIST };
    const first = await runImport(request, { dbName: DB, fetch: serve(files) });
    let db = await openDb(DB);
    const before = await measureGuide(db, "test");
    db.close();

    // The refresh stores its first guide batch, and then storage is full.
    fillStorageAfter(2);
    const result = await runImport(request, { dbName: DB, fetch: serveInChunks(files) });
    vi.restoreAllMocks();
    expect(result).toMatchObject({ status: "done", channels: 300, guideTrimmed: true });
    expect(result.guideChannels).toBe(first.guideChannels);
    db = await openDb(DB);
    const after = await measureGuide(db, "test");
    expect(after.records).toBe(before.records);
    expect(result.programmes).toBe(after.programmes);
    // Only the channel's day split across the two batches lost the part the
    // second one had.
    expect(after.programmes).toBeGreaterThan(before.programmes - 50);
    const last = channels.findLast(channel => channel.guideId);
    expect((await readGuide(db, "test", last.guideId, window.start, window.end)).length).toBeGreaterThan(0);
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
