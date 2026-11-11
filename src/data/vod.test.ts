import { afterEach, describe, expect, it } from "vitest";
import { catalog, guideWindow } from "../../scripts/test-streams/catalog.mjs";
import { m3u } from "../../scripts/test-streams/playlist.mjs";
import { filmTmdb, seriesTmdb, vodLibrary, vodLines } from "../../scripts/test-streams/vod.mjs";
import { playerApi } from "../../scripts/test-streams/xtream.mjs";
import { deleteDb, openDb, prepareDb, readChannels, readImport, readVod, request } from "./db";
import { runImport } from "./importer";
import { episodeTitle, nameYear, parseEpisodeName, vodKind, xtreamFilmInfo, xtreamSeriesInfo } from "./vod";
import type { XtreamLogin } from "./xtream";

const BASE = "http://vod.test:8080";
const DB = "velio-vod-test";
const LOGIN: XtreamLogin = { server: BASE, username: "test", password: "test" };
const urlOf = (input: RequestInfo | URL) => (input instanceof Request ? input.url : input.toString());

// The test server's mock Xtream API, and its playlists, as a fetch.
const mockServer = (count: number): typeof fetch => {
  const account = { username: "test", password: "test", catalog: catalog(count) };
  const window = guideWindow(1);
  return input => {
    const url = new URL(urlOf(input));
    if (url.pathname === "/player_api.php") {
      return Promise.resolve(
        new Response(
          JSON.stringify(playerApi(url, { account, base: BASE, host: url.host, now: Date.now(), window })),
        ),
      );
    }
    if (url.pathname === "/plain.m3u") {
      // As the test server's playlist with ?vod=1: films and episodes as video files.
      const lines = vodLines(
        vodLibrary(count),
        BASE,
        (kind, id, ext) => `${BASE}/vod/film.${ext === "mkv" ? "mkv" : "mp4"}?${kind}=${id}`,
      );
      return Promise.resolve(
        new Response(`${m3u({ base: BASE, channels: account.catalog.channels })}${lines.join("\n")}\n`),
      );
    }
    if (url.pathname === "/get.m3u") {
      const lines = vodLines(
        vodLibrary(count),
        BASE,
        (kind, id, ext) => `${BASE}/${kind}/test/test/${id}.${ext}`,
      );
      return Promise.resolve(
        new Response(`${m3u({ base: BASE, channels: account.catalog.channels })}${lines.join("\n")}\n`),
      );
    }
    return Promise.resolve(new Response("", { status: 404 }));
  };
};

afterEach(async () => {
  await deleteDb(DB);
});

describe("a film's year from its name", () => {
  it("is the one in brackets, not a number that may be the title's own", () => {
    expect(nameYear("Blade Runner 2049 (2017)")).toBe(2017);
    expect(nameYear("2001: A Space Odyssey (1968)")).toBe(1968);
    expect(nameYear("EN - 1917 [2019] [4K]")).toBe(2019);
    expect(nameYear("Tenet 2020")).toBeUndefined();
    expect(nameYear("The Great Adventure")).toBeUndefined();
    // Asked again, the expression starts over.
    expect(nameYear("1917 (2019)")).toBe(2019);
  });
});

describe("films and series", () => {
  it("tell films and episodes from channels", () => {
    expect(vodKind({ url: "http://x/movie/u/p/12.mkv", name: "A film" })).toBe("film");
    expect(vodKind({ url: "http://x/series/u/p/50.mp4", name: "Show S01 E02" })).toBe("episode");
    expect(vodKind({ url: "http://x/films/a.mp4?token=1", name: "A film (1999)" })).toBe("film");
    expect(vodKind({ url: "http://x/a.mkv", name: "Show S2E10 The end" })).toBe("episode");
    expect(vodKind({ url: "http://x/live/u/p/12.ts", name: "News" })).toBeUndefined();
    expect(vodKind({ url: "http://x/hls/news.m3u8", name: "News S01 E01" })).toBeUndefined();
    expect(parseEpisodeName("Show Name - S01E02 - Pilot")).toEqual({
      series: "Show Name",
      season: 1,
      episode: 2,
      title: "Pilot",
    });
    expect(parseEpisodeName("Just a film")).toBeUndefined();
    expect(episodeTitle({ title: "Show - S01 E02 - Pilot", season: 1, episode: 2 })).toBe("Pilot");
    expect(episodeTitle({ title: "Pilot", season: 1, episode: 2 })).toBe("Pilot");
  });

  it("come from a plain playlist, kept apart from the channels, with episodes in their series", async () => {
    const library = vodLibrary(40);
    const result = await runImport(
      { source: "p", playlistUrl: `${BASE}/plain.m3u`, guideUrls: [] },
      { dbName: DB, fetch: mockServer(40) },
    );
    expect(result).toMatchObject({
      channels: 40,
      films: library.films.length,
      series: library.series.length,
    });
    const db = await openDb(DB);
    expect(await readChannels(db, "p")).toHaveLength(40);
    const vod = await readVod(db, "p");
    db.close();
    const film = library.films[3];
    expect(vod.films[3]).toMatchObject({ id: `m:${film.id}`, name: film.name, category: film.genre });
    const show = library.series[0];
    const stored = vod.series.find(one => one.name === show.name);
    const episodes = show.seasons.flat();
    expect(stored?.episodes?.map(one => [one.id, one.season, one.episode])).toEqual(
      episodes.map(one => [`e:${one.id}`, one.season, one.episode]),
    );
  });

  it("come from Xtream's get.php playlist with the provider's ids", async () => {
    await runImport(
      { source: "g", playlistUrl: `${BASE}/get.m3u`, guideUrls: [] },
      { dbName: DB, fetch: mockServer(40) },
    );
    const db = await openDb(DB);
    const vod = await readVod(db, "g");
    db.close();
    const library = vodLibrary(40);
    expect(vod.films.map(film => film.id)).toEqual(library.films.map(film => `m:${film.id}`));
    expect(vod.series[0].episodes?.[0].url).toBe(
      `${BASE}/series/test/test/${library.series[0].seasons[0][0].id}.mp4`,
    );
  });

  it("come from an Xtream account, with details and episodes when opened", async () => {
    const fetcher = mockServer(80);
    const result = await runImport(
      { kind: "xtream", source: "x", ...LOGIN, guideUrls: [] },
      { dbName: DB, fetch: fetcher },
    );
    const library = vodLibrary(80);
    expect(result).toMatchObject({ films: library.films.length, series: library.series.length });
    const db = await openDb(DB);
    const vod = await readVod(db, "x");
    db.close();
    const film = library.films[0];
    expect(vod.films[0]).toMatchObject({
      id: `m:${film.id}`,
      url: `${BASE}/movie/test/test/${film.id}.${film.container}`,
      year: film.year,
      providerId: String(film.id),
    });
    expect(await xtreamFilmInfo(LOGIN, String(film.id), fetcher)).toMatchObject({
      plot: film.plot,
      director: film.director,
      durationMs: 360_000,
      backdrop: `${BASE}${film.poster?.replace("/poster/", "/backdrop/")}`,
      tmdb: filmTmdb(film.id),
    });
    // The list gives a series' TMDB id, and it's kept.
    expect(vod.series[1].tmdb).toBe(seriesTmdb(library.series[1].id));
    const show = library.series[1];
    const details = await xtreamSeriesInfo(LOGIN, String(show.id), fetcher);
    expect(details.backdrop).toBe(`${BASE}${show.poster.replace("/poster/", "/backdrop/")}`);
    expect(details.seasons.map(season => season.episodes.length)).toEqual(
      show.seasons.map(season => season.length),
    );
    expect(details.seasons[0].episodes[0]).toMatchObject({
      id: `e:${show.seasons[0][0].id}`,
      season: 1,
      episode: 1,
      durationMs: 360_000,
    });
  });

  it("keep a version 3 database's data when the store for them is added", async () => {
    const old = await request<IDBDatabase>(
      (() => {
        const opening = indexedDB.open(DB, 3);
        opening.addEventListener("upgradeneeded", () => {
          const db = opening.result;
          db.createObjectStore("imports", { keyPath: "source" }).put({ source: "kept", status: "done" });
          db.createObjectStore("channelLists", { keyPath: "source" });
          db.createObjectStore("guideChannels", { keyPath: ["source", "id"] });
          db.createObjectStore("guide", { keyPath: ["source", "channel", "day"] });
        });
        return opening;
      })(),
    );
    old.close();
    const db = await openDb(DB);
    expect(await readImport(db, "kept")).toMatchObject({ status: "done" });
    expect(await readVod(db, "kept")).toEqual({ source: "kept", films: [], series: [] });
    db.close();
  });

  it("are read as stored before they were in columns", async () => {
    let db = await openDb(DB);
    const films = [{ id: "m:1", name: "One", url: "http://a/1.mp4" }];
    const series = [
      {
        id: "s:a",
        name: "A",
        episodes: [{ id: "e:1", season: 1, episode: 1, title: "", url: "http://a/e1.mp4" }],
      },
    ];
    const writing = db.transaction("vod", "readwrite");
    writing.objectStore("vod").put({ source: "old", films, series });
    await new Promise(resolve => writing.addEventListener("complete", resolve));
    db.close();
    db = await openDb(DB);
    expect(await readVod(db, "old")).toEqual({ source: "old", films, series });
    db.close();
  });

  it("make a database again that can't be opened", async () => {
    // A newer version than the app's can't be opened by it.
    const newer = await request<IDBDatabase>(
      (() => {
        const opening = indexedDB.open(DB, 99);
        opening.addEventListener("upgradeneeded", () => opening.result.createObjectStore("other"));
        return opening;
      })(),
    );
    newer.close();
    expect(await prepareDb(DB)).toBe("remade");
    const db = await openDb(DB);
    expect(db.objectStoreNames.contains("guideIndex")).toBe(true);
    db.close();
    expect(await prepareDb(DB)).toBe("opened");
  });

  // Version 4 kept a record per channel per day, and version 5 blocks keyed by source.
  it.each([
    [4, ["source", "channel", "day"], undefined],
    [5, ["source", "generation", "day", "block"], "source"],
  ])(
    "replace a version %i database's guide, and import every source again",
    async (version, keyPath, index) => {
      const old = await request<IDBDatabase>(
        (() => {
          const opening = indexedDB.open(DB, version);
          opening.addEventListener("upgradeneeded", () => {
            const db = opening.result;
            db.createObjectStore("imports", { keyPath: "source" }).put({
              source: "kept",
              status: "done",
              programmes: 10,
              guideBytes: 100,
              lastDoneAt: 5,
            });
            db.createObjectStore("channelLists", { keyPath: "source" });
            if (index) db.createObjectStore("guideIndex", { keyPath: index });
            else db.createObjectStore("guideChannels", { keyPath: ["source", "id"] });
            db.createObjectStore("guide", { keyPath }).put({
              source: "kept",
              channel: "one",
              generation: 1,
              block: 0,
              day: 1,
            });
            db.createObjectStore("vod", { keyPath: "source" });
          });
          return opening;
        })(),
      );
      old.close();
      const db = await openDb(DB);
      expect(await readImport(db, "kept")).toMatchObject({
        status: "done",
        programmes: 0,
        guideBytes: 0,
        lastDoneAt: 0,
      });
      const guide = db.transaction("guide").objectStore("guide");
      expect(guide.keyPath).toEqual(["guide", "generation", "day", "block"]);
      expect(await request(guide.count())).toBe(0);
      expect(db.transaction("guideIndex").objectStore("guideIndex").keyPath).toBe("guide");
      expect(db.objectStoreNames.contains("guides")).toBe(true);
      expect(db.objectStoreNames.contains("guideChannels")).toBe(false);
      db.close();
    },
  );
});
