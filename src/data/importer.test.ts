import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog, guideWindow, programmesBetween } from "../../scripts/test-streams/catalog.mjs";
import { m3u, xmltv } from "../../scripts/test-streams/playlist.mjs";
import {
  DAY,
  deleteDb,
  deleteSource,
  guideKey,
  measureGuide,
  openDb,
  readChannels,
  readGuide,
  readImport,
  request as idbRequest,
  sourceRange,
} from "./db";
import { localDayStart } from "./guideWanted";
import { importSource } from "./importClient";
import { runImport, type ImportProgress } from "./importer";
import type { GuideBlock } from "./db";

const BASE = "http://test.local";
const HOUR = 3_600_000;
const DB = "tiviplayer-test";
const PLAYLIST = `${BASE}/playlist.m3u`;
const GUIDE = `${BASE}/guide.xml.gz`;
const GUIDE_KEY = guideKey([GUIDE]) ?? "";

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

// Every block of a guide, of any generation.
const allBlocks = async (guide = GUIDE_KEY) => {
  const db = await openDb(DB);
  const blocks = await idbRequest<GuideBlock[]>(
    db.transaction("guide").objectStore("guide").getAll(sourceRange(guide)),
  );
  db.close();
  return blocks;
};

// From the `after`th write to the guide store alone (the first is the
// import's clean-up), `times` writes fail as they do when storage is full.
const fillStorageAfter = (after: number, times = Infinity) => {
  // Called with the database as `this` below.
  // oxlint-disable-next-line typescript/unbound-method
  const transaction = IDBDatabase.prototype.transaction;
  let writes = 0;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const opened = transaction.apply(this, args);
    if (args[0] === "guide" && args[1] === "readwrite" && ++writes >= after && writes < after + times) {
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
    // Only programmes before the times kept from are left out.
    expect(result.skippedProgrammes).toBeGreaterThan(0);
    expect(result.programmes + result.skippedProgrammes).toBe(result.programmesRead);
    expect(progress[progress.length - 1]).toMatchObject({
      stage: "guide",
      programmes: result.programmesRead,
    });

    const db = await openDb(DB);
    expect(await readImport(db, "test")).toMatchObject({ status: "done", channels: 120 });
    expect((await readChannels(db, "test")).map(c => c.name)).toEqual(channels.map(c => c.name));
    expect(result.guideChannels).toBe(new Set(channels.map(c => c.guideId).filter(Boolean)).size);

    // Each channel's guide reads back as generated, across midnight too.
    const from = window.start + 46 * HOUR;
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

  it("refreshes, and keeps the old data if a refresh fails", async () => {
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
    expect((await readGuide(db, "test", guideId, window.start, window.end)).length).toBeGreaterThan(0);
    db.close();
    // Nothing of the failed refresh's guide is left.
    const blocks = await allBlocks();
    expect(new Set(blocks.map(block => block.generation)).size).toBe(1);

    // A refresh with fewer channels deletes the ones that went.
    const smaller = await source(30, 20);
    await runImport(request, { dbName: DB, fetch: serve(smaller.files) });
    db = await openDb(DB);
    expect(await readImport(db, "test")).toMatchObject({ status: "done", channels: 20 });
    expect(await readChannels(db, "test")).toHaveLength(20);
    expect(await readGuide(db, "test", guideId, window.start, window.end)).toEqual([]);
    db.close();
    // Only the last refresh's guide is left.
    expect(new Set((await allBlocks()).map(block => block.generation)).size).toBe(1);
  });

  it("stores the guide in blocks over 64 KB, but for each day's last", async () => {
    const { files } = await source(600);
    await runImport({ source: "test", playlistUrl: PLAYLIST }, { dbName: DB, fetch: serve(files) });
    const blocks = await allBlocks();
    const days = new Map<number, GuideBlock[]>();
    for (const block of blocks) days.set(block.day, [...(days.get(block.day) ?? []), block]);
    let checked = 0;
    for (const list of days.values()) {
      const last = Math.max(...list.map(block => block.block));
      for (const block of list) {
        if (block.block === last) continue;
        expect(block.data.length + (block.details?.length ?? 0)).toBeGreaterThan(65_536);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("keeps descriptions only for the days near today", async () => {
    const { channels, window, files } = await source(20);
    // Today is the day before the guide starts: it has only tomorrow near.
    await runImport(
      { source: "test", playlistUrl: PLAYLIST },
      { dbName: DB, fetch: serve(files), now: window.start - DAY },
    );
    const db = await openDb(DB);
    const channel = channels.find(c => c.guideId);
    const near = await readGuide(db, "test", channel.guideId, window.start, window.start + DAY);
    const far = await readGuide(db, "test", channel.guideId, window.start + DAY, window.end);
    db.close();
    expect(near.filter(p => p.start >= window.start).every(p => p.description)).toBe(true);
    expect(far.filter(p => p.start >= window.start + DAY).length).toBeGreaterThan(0);
    expect(far.filter(p => p.start >= window.start + DAY).some(p => p.description)).toBe(false);
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
    // Today is the day kept.
    const today = Math.floor(Date.now() / DAY);
    expect([result.guideFirstDay, result.guideLastDay]).toEqual([today, today]);
  });

  it("drops the days farthest from today to stay within the budget", async () => {
    const { channels, window, files } = await source(60);
    const request = { source: "test", playlistUrl: PLAYLIST, guideDays: 3, guidePastDays: 1 };
    const whole = await runImport(request, { dbName: DB, fetch: serve(files) });
    // Room for about two of the guide's days.
    const days = whole.guideLastDay - whole.guideFirstDay + 1;
    const budget = Math.round((whole.guideBytes / days) * 2.2);
    const result = await runImport(
      { ...request, source: "small", guideBudgetBytes: budget },
      { dbName: DB, fetch: serve(files) },
    );
    expect(result.guideTrimmed).toBe(true);
    expect(result.guideBytes).toBeLessThanOrEqual(budget);
    // Today and yesterday stay; tomorrow and the day after go.
    const today = Math.floor(Date.now() / DAY);
    expect([result.guideFirstDay, result.guideLastDay]).toEqual([today - 1, today]);
    expect(result.programmes).toBeLessThan(result.programmesRead);

    // The days kept are all there; the dropped ones are gone.
    const db = await openDb(DB);
    const channel = channels.find(c => c.guideId);
    const from = (today - 1) * DAY;
    const to = (today + 1) * DAY;
    const kept = await readGuide(db, "small", channel.guideId, from, to);
    const expected = programmesBetween(channel, window, from, to).filter(p => p.start >= from);
    expect(kept.filter(p => p.start >= from).map(p => p.start)).toEqual(expected.map(p => p.start));
    const later = await readGuide(db, "small", channel.guideId, to, window.end + DAY);
    expect(later.filter(p => p.start >= to)).toEqual([]);
    db.close();
  });
});

// A time on the guide's second day (today) that is past local midnight anywhere.
const from = (window: { start: number }) => window.start + 46 * HOUR;

describe("what the guide keeps", () => {
  it("keeps a channel's past only as far back as its catch-up reaches", async () => {
    const { channels, window, files } = await source(40);
    // Noon on the guide's third day.
    const now = window.start + 2 * DAY + 12 * HOUR;
    await runImport({ source: "test", playlistUrl: PLAYLIST }, { dbName: DB, fetch: serve(files), now });
    const db = await openDb(DB);
    const shares = (guideId: string) => channels.filter(c => c.guideId === guideId).length > 1;
    const plain = channels.find(c => c.guideId && !c.archiveDays && !shares(c.guideId));
    const catchup = channels.find(c => c.guideId && c.archiveDays === 3);
    const plainList = await readGuide(db, "test", plain.guideId, window.start, now);
    expect(plainList.length).toBeGreaterThan(0);
    expect(plainList.every(p => p.stop > localDayStart(now))).toBe(true);
    // Its catch-up reaches back 3 days, to before the guide starts.
    const catchupList = await readGuide(db, "test", catchup.guideId, window.start, now);
    expect(catchupList[0].start).toBeLessThanOrEqual(window.start);
    db.close();
  });

  it("leaves out the guides of hidden channels and groups", async () => {
    const { window, files } = await source(60);
    const request = { source: "test", playlistUrl: PLAYLIST };
    const whole = await runImport(request, { dbName: DB, fetch: serve(files) });
    let db = await openDb(DB);
    const stored = await readChannels(db, "test");
    db.close();
    const alone = stored.filter(c => c.guideId && stored.filter(o => o.guideId === c.guideId).length === 1);
    const hidden = alone[0];
    // A group with two channels of their own guide: one is moved out of it.
    const group = alone.find(
      c => c.group !== hidden.group && alone.some(o => o !== c && o.group === c.group),
    );
    const inGroup = alone.filter(c => c.group === group?.group);
    const [gone, moved] = inGroup;
    const result = await runImport(
      {
        ...request,
        guideFilter: {
          hiddenChannels: [hidden.id],
          hiddenGroups: [group?.group ?? ""],
          movedChannels: { [moved.id]: "Elsewhere" },
        },
      },
      { dbName: DB, fetch: serve(files) },
    );
    expect(result.guideChannels).toBe(whole.guideChannels - inGroup.length - 1 + 1);
    db = await openDb(DB);
    const read = (id = "") => readGuide(db, "test", id, from(window), from(window) + 6 * HOUR);
    expect(await read(hidden.guideId)).toEqual([]);
    expect(await read(gone.guideId)).toEqual([]);
    expect((await read(moved.guideId)).length).toBeGreaterThan(0);
    db.close();
  });

  it("stores a guide once for the sources that use it, with what each wants", async () => {
    const { channels, window, files } = await source(60);
    const OTHER = `${BASE}/other.m3u`;
    files[PLAYLIST] = m3u({ base: BASE, channels: channels.slice(0, 30), guideUrl: GUIDE });
    files[OTHER] = m3u({ base: BASE, channels: channels.slice(30), guideUrl: GUIDE });
    const ids = (list: typeof channels): Set<string> =>
      new Set(list.map(c => c.guideId).filter((id): id is string => typeof id === "string"));
    const onlyA = Array.from(ids(channels.slice(0, 30))).find(id => !ids(channels.slice(30)).has(id));
    const onlyB = Array.from(ids(channels.slice(30))).find(id => !ids(channels.slice(0, 30)).has(id));
    const a = await runImport({ source: "a", playlistUrl: PLAYLIST }, { dbName: DB, fetch: serve(files) });
    // b wants channels a's copy didn't keep, so it is imported again, for both.
    const b = await runImport({ source: "b", playlistUrl: OTHER }, { dbName: DB, fetch: serve(files) });
    expect(b.guideSkipped).toBeUndefined();
    expect(b.programmes).toBeGreaterThan(a.programmes);
    const db = await openDb(DB);
    const read = (owner: string, id = "") => readGuide(db, owner, id, from(window), from(window) + 6 * HOUR);
    expect((await read("a", onlyA)).length).toBeGreaterThan(0);
    expect((await read("b", onlyB)).length).toBeGreaterThan(0);
    expect(new Set((await allBlocks()).map(block => block.generation))).toEqual(new Set([2]));

    // a, refreshed within the hour of b's import, uses the copy as it is.
    const again = await runImport(
      { source: "a", playlistUrl: PLAYLIST },
      { dbName: DB, fetch: serve(files) },
    );
    expect(again).toMatchObject({ guideSkipped: "shared", programmes: b.programmes });
    expect(again.guideChannels).toBe(a.guideChannels);

    // Removing one source keeps the guide for the other; removing both deletes it.
    await deleteSource(db, "a");
    expect((await read("b", onlyB)).length).toBeGreaterThan(0);
    await deleteSource(db, "b");
    db.close();
    expect(await allBlocks()).toEqual([]);
  });

  it("deletes the guide a source no longer uses", async () => {
    const { files } = await source(20);
    const OTHER_GUIDE = `${BASE}/other.xml.gz`;
    files[OTHER_GUIDE] = files[GUIDE];
    const request = { source: "test", playlistUrl: PLAYLIST };
    await runImport(request, { dbName: DB, fetch: serve(files) });
    expect((await allBlocks()).length).toBeGreaterThan(0);
    await runImport({ ...request, guideUrls: [OTHER_GUIDE] }, { dbName: DB, fetch: serve(files) });
    expect(await allBlocks()).toEqual([]);
    expect((await allBlocks(guideKey([OTHER_GUIDE]))).length).toBeGreaterThan(0);
  });

  it("doesn't download a guide again that hasn't changed since today's import", async () => {
    const { files } = await source(20);
    let version = 1;
    let downloads = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (input !== GUIDE) return serve(files)(input);
      const etag = `"${version}"`;
      if (new Headers(init?.headers).get("If-None-Match") === etag)
        return new Response(null, { status: 304 });
      downloads++;
      return new Response(files[GUIDE], { headers: { ETag: etag } });
    };
    const request = { source: "test", playlistUrl: PLAYLIST };
    const first = await runImport(request, { dbName: DB, fetch: fetcher });
    const second = await runImport(request, { dbName: DB, fetch: fetcher });
    expect(second).toMatchObject({
      guideSkipped: "unchanged",
      programmes: first.programmes,
      guideChannels: first.guideChannels,
    });
    expect(downloads).toBe(1);

    // Changed: the answer to the question is the download.
    version = 2;
    const third = await runImport(request, { dbName: DB, fetch: fetcher });
    expect(third.guideSkipped).toBeUndefined();
    expect(third.programmes).toBe(first.programmes);
    expect(downloads).toBe(2);

    // The next day, the days that keep details have moved: imported again.
    const later = await runImport(request, { dbName: DB, fetch: fetcher, now: Date.now() + DAY });
    expect(later.guideSkipped).toBeUndefined();
    expect(downloads).toBe(3);
  });
});

// Enough channels for a few batches of blocks.
const big = () => source(1500);

describe("full storage", () => {
  it("deletes the old guide early to make room for the new one", async () => {
    const { channels, window, files } = await big();
    const request = { source: "test", playlistUrl: PLAYLIST };
    const first = await runImport(request, { dbName: DB, fetch: serve(files) });

    // The refresh's first batch doesn't fit beside the old guide.
    fillStorageAfter(2, 1);
    const result = await runImport(request, { dbName: DB, fetch: serveInChunks(files) });
    vi.restoreAllMocks();
    expect(result).toMatchObject({ status: "done", guideTrimmed: false, programmes: first.programmes });
    const blocks = await allBlocks();
    expect(new Set(blocks.map(block => block.generation))).toEqual(new Set([2]));
    const db = await openDb(DB);
    const last = channels.findLast(channel => channel.guideId);
    expect((await readGuide(db, "test", last.guideId, window.start, window.end)).length).toBeGreaterThan(0);
    db.close();
  });

  it("stops storing when even that isn't enough, and keeps what it stored", async () => {
    const { channels, window, files } = await big();
    const request = { source: "test", playlistUrl: PLAYLIST };
    const first = await runImport(request, { dbName: DB, fetch: serve(files) });

    // The refresh stores its first batch, and then storage is full.
    fillStorageAfter(3);
    const result = await runImport(request, { dbName: DB, fetch: serveInChunks(files) });
    vi.restoreAllMocks();
    expect(result).toMatchObject({ status: "done", channels: 1500, guideTrimmed: true });
    expect(result.guideChannels).toBe(first.guideChannels);
    const db = await openDb(DB);
    const after = await measureGuide(db, GUIDE_KEY);
    expect(result.programmes).toBe(after.programmes);
    expect(after.programmes).toBeGreaterThan(0);
    expect(after.programmes).toBeLessThan(first.programmes);
    // The first channels have their guide; the old one went to make room.
    const firstChannel = channels.find(channel => channel.guideId);
    expect(
      (await readGuide(db, "test", firstChannel.guideId, window.start, window.end)).length,
    ).toBeGreaterThan(0);
    db.close();
    expect(new Set((await allBlocks()).map(block => block.generation))).toEqual(new Set([2]));
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
