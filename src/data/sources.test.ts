import { describe, expect, it } from "vitest";
import type { ImportState } from "./db";
import { memoryStorage } from "./memoryStorage";
import {
  changesData,
  defaultSourceName,
  guideBudget,
  importRequest,
  loadSources,
  refreshDue,
  saveSources,
  sourceProblem,
  sourcesFor,
  syncedSource,
  splitGuideUrls,
  type Source,
} from "./sources";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 2, 12);

const m3u: Source = { id: "a", name: "A", kind: "m3u", url: "http://example.com/a.m3u", refreshHours: 24 };
const xtream: Source = {
  id: "b",
  name: "B",
  kind: "xtream",
  server: "example.com:8080",
  username: "user",
  password: "pass",
  refreshHours: 12,
};

const state = (fields: Partial<ImportState>): ImportState => ({
  source: "a",
  status: "done",
  startedAt: NOW - 2 * HOUR,
  channels: 10,
  guideChannels: 10,
  programmes: 100,
  guideBytes: 1000,
  guideFirstDay: 0,
  guideLastDay: 0,
  guideTrimmed: false,
  ...fields,
});

describe("saving sources", () => {
  it("saves and loads them", () => {
    const storage = memoryStorage();
    saveSources(storage, [m3u, { ...xtream, guideUrls: ["http://example.com/g.xml"] }]);
    expect(loadSources(storage)).toEqual([m3u, { ...xtream, guideUrls: ["http://example.com/g.xml"] }]);
  });

  it("copes with nothing saved, broken JSON and broken entries", () => {
    const storage = memoryStorage();
    expect(loadSources(storage)).toEqual([]);
    storage.setItem("velio.sources", "{");
    expect(loadSources(storage)).toEqual([]);
    storage.setItem(
      "velio.sources",
      JSON.stringify({
        version: 1,
        sources: [{ id: "x", kind: "other" }, { kind: "m3u" }, { id: "y", kind: "m3u", refreshHours: -1 }],
      }),
    );
    expect(loadSources(storage)).toEqual([{ id: "y", name: "", kind: "m3u", refreshHours: 24 }]);
  });
});

describe("checking a draft", () => {
  it("needs a web URL for M3U, and a full login for Xtream", () => {
    expect(sourceProblem(m3u)).toBeUndefined();
    expect(sourceProblem({ ...m3u, url: undefined })).toBe("source.problem.url");
    expect(sourceProblem({ ...m3u, url: "example.com/a.m3u" })).toBe("source.problem.urlForm");
    expect(sourceProblem(xtream)).toBeUndefined();
    expect(sourceProblem({ ...xtream, server: undefined })).toBe("source.problem.server");
    expect(sourceProblem({ ...xtream, password: undefined })).toBe("source.problem.login");
    expect(sourceProblem({ ...m3u, guideUrls: ["guide.xml"] })).toBe("source.problem.guideForm");
  });

  it("names a source after its host", () => {
    expect(defaultSourceName(m3u)).toBe("example.com");
    expect(defaultSourceName(xtream)).toBe("example.com");
    expect(defaultSourceName({ ...m3u, url: "not a url" })).toBe("");
  });

  it("splits guide URLs on spaces", () => {
    expect(splitGuideUrls("  http://a/1.xml   http://b/2.xml.gz ")).toEqual([
      "http://a/1.xml",
      "http://b/2.xml.gz",
    ]);
    expect(splitGuideUrls(" ")).toEqual([]);
  });

  it("knows which changes need a new import", () => {
    expect(changesData(m3u, { ...m3u, name: "New", refreshHours: 6 })).toBe(false);
    expect(changesData(m3u, { ...m3u, url: "http://example.com/b.m3u" })).toBe(true);
    expect(changesData(m3u, { ...m3u, guideUrls: ["http://example.com/g.xml"] })).toBe(true);
    expect(changesData(xtream, { ...xtream, password: "other" })).toBe(true);
  });
});

describe("importRequest", () => {
  it("builds the request for each kind", () => {
    expect(importRequest(m3u)).toEqual({ source: "a", kind: "m3u", playlistUrl: m3u.url });
    expect(importRequest({ ...xtream, guideUrls: ["http://g"] }, 5000)).toEqual({
      source: "b",
      kind: "xtream",
      server: "example.com:8080",
      username: "user",
      password: "pass",
      guideUrls: ["http://g"],
      guideBudgetBytes: 5000,
    });
  });
});

describe("refreshDue", () => {
  it("imports what was never imported, or was cut short", () => {
    expect(refreshDue(m3u, undefined, NOW)).toBe(true);
    expect(refreshDue(m3u, state({ status: "importing", startedAt: NOW - 60_000 }), NOW)).toBe(true);
  });

  it("refreshes after the source's refresh time", () => {
    const done = state({ finishedAt: NOW - 23 * HOUR, lastDoneAt: NOW - 23 * HOUR });
    expect(refreshDue(m3u, done, NOW)).toBe(false);
    expect(refreshDue(m3u, done, NOW + HOUR)).toBe(true);
    expect(refreshDue(xtream, done, NOW)).toBe(true);
  });

  it("retries a failed import after an hour", () => {
    const failed = state({ status: "failed", finishedAt: NOW - 30 * 60_000, lastDoneAt: NOW - 30 * HOUR });
    expect(refreshDue(m3u, failed, NOW)).toBe(false);
    expect(refreshDue(m3u, failed, NOW + 30 * 60_000)).toBe(true);
  });
});

describe("guideBudget", () => {
  it("gives each source what the others leave, and at least an equal share", () => {
    expect(guideBudget(100, 1, 0)).toBe(100);
    expect(guideBudget(100, 2, 0)).toBe(100);
    expect(guideBudget(100, 2, 40)).toBe(60);
    expect(guideBudget(100, 2, 70)).toBe(50);
    expect(guideBudget(100, 5, 100)).toBe(20);
  });
});

describe("synced lists", () => {
  it("become sources that keep their id, profiles and settings", () => {
    const source = syncedSource(
      {
        format: 1,
        id: "list-1",
        rev: 3,
        name: "Account list",
        kind: "xtream",
        server: "http://xtream.example.invalid",
        username: "u",
        password: "p",
        guideUrls: ["http://guide.example.invalid/a.xml"],
        refreshHours: 12,
        disabled: true,
      },
      ["p1"],
    );
    expect(source).toEqual({
      id: "list-1",
      name: "Account list",
      kind: "xtream",
      server: "http://xtream.example.invalid",
      username: "u",
      password: "p",
      guideUrls: ["http://guide.example.invalid/a.xml"],
      refreshHours: 12,
      disabled: true,
      synced: true,
      profiles: ["p1"],
    });
    const storage = memoryStorage();
    saveSources(storage, [source]);
    expect(loadSources(storage)).toEqual([source]);
  });

  it("are in the lineups of their profiles only, with the TV's own sources in every one", () => {
    const own = { id: "own", name: "Own", kind: "m3u" as const, url: "http://a.invalid", refreshHours: 24 };
    const shared = { ...own, id: "s", synced: true as const, profiles: ["p1", "p2"] };
    const kids = { ...own, id: "k", synced: true as const, profiles: ["p2"] };
    const all = [own, shared, kids];
    expect(sourcesFor(all, "p1").map(s => s.id)).toEqual(["own", "s"]);
    expect(sourcesFor(all, "p2").map(s => s.id)).toEqual(["own", "s", "k"]);
    expect(sourcesFor(all, undefined).map(s => s.id)).toEqual(["own"]);
  });
});
