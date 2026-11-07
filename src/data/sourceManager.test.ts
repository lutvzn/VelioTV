import { afterEach, describe, expect, it } from "vitest";
import { catalog, guideWindow } from "../../scripts/test-streams/catalog.mjs";
import { m3u, xmltv } from "../../scripts/test-streams/playlist.mjs";
import { deleteDb, openDb, readChannels, readImport } from "./db";
import { runImport, type ImportProgress, type ImportRequest } from "./importer";
import { memoryStorage } from "./memoryStorage";
import { createSourceManager, type Importer, type SourceManager } from "./sourceManager";
import { loadSources, saveSources, type Source, type SourceDraft } from "./sources";

const BASE = "http://test.local";
const DB = "tiviplayer-manager-test";
const HOUR = 3_600_000;

// Two playlists of the test server's channels, one with a guide.
const files = (() => {
  const { channels } = catalog(40);
  const window = guideWindow(2);
  return {
    [`${BASE}/a.m3u`]: m3u({ base: BASE, channels: channels.slice(0, 20), guideUrl: `${BASE}/guide.xml` }),
    [`${BASE}/b.m3u`]: m3u({ base: BASE, channels: channels.slice(20, 25) }),
    [`${BASE}/guide.xml`]: [...xmltv({ base: BASE, channels, window })].join(""),
  } as Record<string, string | undefined>;
})();

const serve: typeof fetch = input => {
  const body = files[input instanceof Request ? input.url : input.toString()];
  return Promise.resolve(body === undefined ? new Response("", { status: 404 }) : new Response(body));
};

const draft = (name: string, url: string): SourceDraft => ({ name, kind: "m3u", url, refreshHours: 24 });

// The real importer, on this thread, recording what it was asked.
const recording = () => {
  const requests: ImportRequest[] = [];
  const importer: Importer = (request, onProgress) => {
    requests.push(request);
    return runImport(request, { dbName: DB, fetch: serve, onProgress });
  };
  return { requests, importer };
};

let manager: SourceManager | undefined;
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await deleteDb(DB);
});

describe("the source manager", () => {
  it("imports a new source, saves it, and reports progress", async () => {
    const storage = memoryStorage();
    const { importer } = recording();
    const progress: (ImportProgress | undefined)[] = [];
    manager = createSourceManager({
      dbName: DB,
      storage,
      importer: (request, onProgress, signal) =>
        importer(
          request,
          p => {
            onProgress(p);
            progress.push(manager?.importing()?.progress);
          },
          signal,
        ),
    });
    const source = manager.add(draft("A", `${BASE}/a.m3u`));
    expect(manager.statusOf(source.id).importing).toBe(true);
    await manager.whenIdle();

    const status = manager.statusOf(source.id);
    expect(status).toMatchObject({
      importing: false,
      queued: false,
      state: { status: "done", channels: 20 },
    });
    expect(status.state?.programmes).toBeGreaterThan(0);
    expect(status.state?.lastDoneAt).toBe(status.state?.finishedAt);
    expect(progress.some(p => p?.stage === "guide")).toBe(true);
    expect(manager.importing()).toBeUndefined();
    expect(loadSources(storage)).toEqual([source]);
  });

  it("imports one source at a time, sharing the guide budget", async () => {
    const storage = memoryStorage();
    saveSources(storage, [
      { id: "a", ...draft("A", `${BASE}/a.m3u`) },
      { id: "b", ...draft("B", `${BASE}/b.m3u`) },
    ]);
    const { importer, requests } = recording();
    manager = createSourceManager({ dbName: DB, storage, importer, guideBudgetBytes: 1000 });
    const stop = await manager.start();
    expect(manager.statusOf("b")).toMatchObject({ importing: false, queued: true });
    await manager.whenIdle();
    stop();
    expect(requests.map(r => r.source)).toEqual(["a", "b"]);
    expect(requests.map(r => r.guideBudgetBytes)).toEqual([500, 500]);

    // A source added later gets a share of what the others leave.
    const c = manager.add(draft("C", `${BASE}/b.m3u`));
    await manager.whenIdle();
    expect(requests[2]).toMatchObject({ source: c.id, guideBudgetBytes: 333 });
  });

  it("at startup, imports only the sources that are due", async () => {
    const storage = memoryStorage();
    const fresh: Source = { id: "fresh", ...draft("Fresh", `${BASE}/a.m3u`) };
    const old: Source = { id: "old", ...draft("Old", `${BASE}/b.m3u`) };
    const never: Source = { id: "never", ...draft("Never", `${BASE}/b.m3u`) };
    saveSources(storage, [fresh, old, never]);
    await runImport({ source: "fresh", playlistUrl: `${BASE}/a.m3u` }, { dbName: DB, fetch: serve });
    await runImport({ source: "old", playlistUrl: `${BASE}/b.m3u` }, { dbName: DB, fetch: serve });
    // Data from a source being removed as the app closed, and from one the list doesn't name.
    await runImport({ source: "gone", playlistUrl: `${BASE}/b.m3u` }, { dbName: DB, fetch: serve });
    await runImport({ source: "unnamed", playlistUrl: `${BASE}/b.m3u` }, { dbName: DB, fetch: serve });
    storage.setItem("tiviplayer.removedSources", JSON.stringify(["gone"]));

    const { importer, requests } = recording();
    // A day and a bit later, the old one is due; the fresh one has a week.
    saveSources(storage, [{ ...fresh, refreshHours: 168 }, old, never]);
    manager = createSourceManager({ dbName: DB, storage, importer, now: () => Date.now() + 25 * HOUR });
    const stop = await manager.start();
    await manager.whenIdle();
    stop();
    expect(requests.map(r => r.source)).toEqual(["old", "never"]);

    await manager.close();
    const db = await openDb(DB);
    expect(await readImport(db, "gone")).toBeUndefined();
    expect(await readChannels(db, "gone")).toEqual([]);
    expect(storage.getItem("tiviplayer.removedSources")).toBeNull();
    // A list that lost a source, as one read empty on the TV once, deletes nothing.
    expect(await readImport(db, "unnamed")).toMatchObject({ status: "done" });
    db.close();
  });

  it("imports again after an edit that changes the data, and not after one that doesn't", async () => {
    const { importer, requests } = recording();
    manager = createSourceManager({ dbName: DB, storage: memoryStorage(), importer });
    const source = manager.add(draft("A", `${BASE}/a.m3u`));
    await manager.whenIdle();
    manager.update(source.id, { ...source, name: "Renamed", refreshHours: 6 });
    await manager.whenIdle();
    expect(requests).toHaveLength(1);
    expect(manager.sources()[0]).toMatchObject({ id: source.id, name: "Renamed", refreshHours: 6 });

    manager.update(source.id, { ...source, url: `${BASE}/b.m3u` });
    await manager.whenIdle();
    expect(requests).toHaveLength(2);
    expect(manager.statusOf(source.id).state).toMatchObject({ status: "done", channels: 5 });
  });

  it("restarts an import that an edit interrupts", async () => {
    const started: string[] = [];
    let cancelled = 0;
    // An import that only ends when cancelled, until the playlist changes.
    const importer: Importer = (request, onProgress, signal) => {
      const url = request.kind === "m3u" ? (request.playlistUrl ?? "") : "";
      started.push(url);
      if (url.endsWith("b.m3u")) return runImport(request, { dbName: DB, fetch: serve, onProgress });
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          cancelled++;
          reject(new DOMException("Import cancelled", "AbortError"));
        }),
      );
    };
    manager = createSourceManager({ dbName: DB, storage: memoryStorage(), importer });
    const source = manager.add(draft("A", `${BASE}/a.m3u`));
    manager.update(source.id, { ...source, url: `${BASE}/b.m3u` });
    await manager.whenIdle();
    expect(cancelled).toBe(1);
    expect(started).toEqual([`${BASE}/a.m3u`, `${BASE}/b.m3u`]);
    expect(manager.statusOf(source.id).state).toMatchObject({ status: "done", channels: 5 });
  });

  it("records a failed import, and keeps the data from before", async () => {
    const { importer } = recording();
    manager = createSourceManager({ dbName: DB, storage: memoryStorage(), importer });
    const source = manager.add(draft("A", `${BASE}/a.m3u`));
    await manager.whenIdle();
    const before = manager.statusOf(source.id).state;

    manager.update(source.id, { ...source, url: `${BASE}/missing.m3u` });
    await manager.whenIdle();
    expect(manager.statusOf(source.id).state).toMatchObject({
      status: "failed",
      error: expect.stringContaining("HTTP 404"),
      channels: 20,
      lastDoneAt: before?.lastDoneAt,
    });
  });

  it("orders sources, turns one off without importing it, and on again", async () => {
    const storage = memoryStorage();
    const { importer, requests } = recording();
    manager = createSourceManager({ dbName: DB, storage, importer });
    const a = manager.add(draft("A", `${BASE}/b.m3u`));
    const b = manager.add(draft("B", `${BASE}/b.m3u`));
    await manager.whenIdle();
    manager.move(b.id, -1);
    manager.move(b.id, -1);
    expect(manager.sources().map(s => s.name)).toEqual(["B", "A"]);
    manager.setDisabled(a.id, true);
    manager.update(a.id, { ...draft("A2", `${BASE}/b.m3u`) });
    expect(loadSources(storage)).toMatchObject([{ name: "B" }, { name: "A2", disabled: true }]);
    manager.check();
    await manager.whenIdle();
    expect(requests).toHaveLength(2);

    // Due again: only the one on imports.
    manager.update(b.id, draft("B", `${BASE}/a.m3u`));
    manager.update(a.id, draft("A2", `${BASE}/a.m3u`));
    await manager.whenIdle();
    expect(requests.slice(2).map(r => r.source)).toEqual([b.id, a.id]);
  });

  it("puts a restored list in place of the sources", async () => {
    const storage = memoryStorage();
    const { importer, requests } = recording();
    manager = createSourceManager({ dbName: DB, storage, importer });
    const old = manager.add(draft("Old", `${BASE}/b.m3u`));
    await manager.whenIdle();
    const restored = await manager.replaceAll([
      { id: "r1", ...draft("R1", `${BASE}/b.m3u`) },
      { id: "r2", ...draft("R2", `${BASE}/b.m3u`), disabled: true },
      { id: "r1", ...draft("Twice", `${BASE}/b.m3u`) },
      { nonsense: true },
    ]);
    await manager.whenIdle();
    expect(restored.map(s => s.name)).toEqual(["R1", "R2"]);
    expect(requests.map(r => r.source)).toEqual([old.id, "r1"]);
    const db = await openDb(DB);
    expect(await readChannels(db, old.id)).toEqual([]);
    db.close();
  });

  it("removes a source and its data", async () => {
    const storage = memoryStorage();
    const { importer } = recording();
    manager = createSourceManager({ dbName: DB, storage, importer });
    const source = manager.add(draft("A", `${BASE}/a.m3u`));
    await manager.whenIdle();
    await manager.remove(source.id);
    expect(manager.sources()).toEqual([]);
    expect(loadSources(storage)).toEqual([]);
    expect(manager.statusOf(source.id).state).toBeUndefined();
    const db = await openDb(DB);
    expect(await readImport(db, source.id)).toBeUndefined();
    expect(await readChannels(db, source.id)).toEqual([]);
    db.close();
  });
});
