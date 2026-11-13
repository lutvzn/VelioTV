import { describe, expect, it } from "vitest";
import {
  addonBase,
  catalogUrl,
  hasCatalogs,
  readCatalog,
  readManifest,
  readMetaAnswer,
  readStreams,
  readSubtitlesAnswer,
  resourceUrl,
  silentSound,
  supports,
} from "./addon";

const MANIFEST = {
  id: "test.addon",
  version: "1.0.0",
  name: "Test add-on",
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  resources: ["catalog", { name: "meta", types: ["movie"], idPrefixes: ["tt", "test:"] }, "stream"],
  catalogs: [
    { type: "movie", id: "top", name: "Top", extra: [{ name: "skip" }, { name: "search" }] },
    { type: "movie", id: "find", name: "Find", extra: [{ name: "search", isRequired: true }] },
    { type: "series", id: "by-genre", name: "Genre", extra: [{ name: "genre", isRequired: true }] },
    { type: "series", id: "old", extraSupported: ["search", "skip"] },
    { type: "movie" },
  ],
  behaviorHints: { configurable: true },
};

describe("an add-on's manifest", () => {
  it("is read loosely, keeping the catalogs the app can show", () => {
    const manifest = readManifest(MANIFEST);
    expect(manifest).toMatchObject({ id: "test.addon", name: "Test add-on", version: "1.0.0" });
    expect(manifest.needsSetup).toBeUndefined();
    expect(manifest.catalogs).toEqual([
      { type: "movie", id: "top", name: "Top", search: true, searchOnly: false, paged: true },
      { type: "movie", id: "find", name: "Find", search: true, searchOnly: true, paged: false },
      // The genre catalog needs a genre, so it's left out; the old one's name is its id.
      { type: "series", id: "old", name: "old", search: true, searchOnly: false, paged: true },
    ]);
    expect(hasCatalogs(manifest)).toBe(true);
    expect(() => readManifest({ name: "No id" })).toThrow(/id/);
    expect(readManifest({ ...MANIFEST, behaviorHints: { configurationRequired: true } }).needsSetup).toBe(
      true,
    );
  });

  it("says which resources it has, for which types and ids", () => {
    const manifest = readManifest(MANIFEST);
    expect(supports(manifest, "stream", "series", "tt0000001:1:2")).toBe(true);
    expect(supports(manifest, "stream", "movie", "kitsu:1")).toBe(false);
    expect(supports(manifest, "meta", "movie", "test:7")).toBe(true);
    expect(supports(manifest, "meta", "series", "tt0000001")).toBe(false);
    expect(supports(manifest, "subtitles", "movie", "tt0000001")).toBe(false);
  });
});

describe("an add-on's addresses", () => {
  it("go under the manifest's, keeping its query", () => {
    expect(addonBase("https://addon.example.invalid/key/manifest.json")).toEqual({
      base: "https://addon.example.invalid/key",
      query: "",
    });
    expect(
      resourceUrl("https://addon.example.invalid/manifest.json?lang=pt", "stream", "series", "tt1:1:2"),
    ).toBe("https://addon.example.invalid/stream/series/tt1%3A1%3A2.json?lang=pt");
  });

  it("put a catalog's extras in its path", () => {
    const url = "https://addon.example.invalid/manifest.json";
    expect(catalogUrl(url, { type: "movie", id: "top" })).toBe(
      "https://addon.example.invalid/catalog/movie/top.json",
    );
    expect(catalogUrl(url, { type: "movie", id: "top" }, { skip: 100 })).toBe(
      "https://addon.example.invalid/catalog/movie/top/skip=100.json",
    );
    expect(catalogUrl(url, { type: "movie", id: "top" }, { search: "big & small" })).toBe(
      "https://addon.example.invalid/catalog/movie/top/search=big%20%26%20small.json",
    );
  });
});

describe("an add-on's answers", () => {
  it("read a catalog's titles, once each", () => {
    const items = readCatalog(
      {
        metas: [
          {
            id: "tt1",
            type: "movie",
            name: "Test Film",
            poster: "https://img.example.invalid/1.jpg",
            releaseInfo: "2019",
            imdbRating: "7.4",
          },
          { id: "tt1", type: "movie", name: "Again" },
          { id: "tt2", name: "No type given", poster: "not a url" },
          { name: "No id" },
        ],
      },
      "movie",
    );
    expect(items).toEqual([
      {
        id: "tt1",
        type: "movie",
        name: "Test Film",
        poster: "https://img.example.invalid/1.jpg",
        year: 2019,
        rating: 7.4,
      },
      { id: "tt2", type: "movie", name: "No type given" },
    ]);
    expect(readCatalog({ error: "nope" }, "movie")).toEqual([]);
  });

  it("read a series' details with its episodes in order, specials last", () => {
    const meta = readMetaAnswer(
      {
        meta: {
          id: "tt9",
          type: "series",
          name: "Test Series",
          description: "A made-up series.",
          runtime: "45 min",
          genres: ["Drama"],
          cast: ["A. Actor", "B. Actor"],
          releaseInfo: "2018-2020",
          videos: [
            { id: "tt9:2:1", season: 2, episode: 1, title: "Two one" },
            { id: "tt9:0:1", season: 0, episode: 1, name: "Special" },
            { id: "tt9:1:2", season: 1, episode: 2, title: "One two", released: "2018-01-08T00:00:00.000Z" },
            { id: "tt9:1:1", season: 1, number: 1, title: "One one", overview: "The first." },
            { id: "broken", title: "No season" },
          ],
        },
      },
      "series",
    );
    expect(meta).toMatchObject({
      name: "Test Series",
      year: 2018,
      durationMs: 45 * 60_000,
      genres: ["Drama"],
      cast: "A. Actor, B. Actor",
    });
    expect(meta?.videos?.map(video => video.id)).toEqual(["tt9:1:1", "tt9:1:2", "tt9:2:1", "tt9:0:1"]);
    expect(meta?.videos?.[0].plot).toBe("The first.");
    expect(meta?.videos?.[1].released).toBe(Date.UTC(2018, 0, 8));
  });

  it("keep only streams the TV can play, with their User-Agent", () => {
    const read = readStreams({
      streams: [
        {
          url: "https://cdn.example.invalid/film.mp4",
          name: "Test 1080p",
          description: "Film\nMP4",
          behaviorHints: {
            bingeGroup: "test-1080",
            proxyHeaders: { request: { "user-agent": "Velio-test" } },
          },
          subtitles: [{ id: "1", url: "https://subs.example.invalid/1.srt", lang: "eng" }],
        },
        { url: "https://cdn.example.invalid/film.m3u8", title: "Older add-on" },
        { infoHash: "0123456789abcdef0123456789abcdef01234567", fileIdx: 0, name: "Torrent" },
        { ytId: "abc" },
        { externalUrl: "https://example.invalid/watch" },
        {
          url: "https://cdn.example.invalid/protected.mp4",
          behaviorHints: { proxyHeaders: { request: { Referer: "https://example.invalid/" } } },
        },
      ],
    });
    expect(read.unplayable).toBe(3);
    expect(read.needReferer).toBe(1);
    expect(read.streams).toEqual([
      {
        url: "https://cdn.example.invalid/film.mp4",
        name: "Test 1080p",
        description: "Film\nMP4",
        userAgent: "Velio-test",
        bingeGroup: "test-1080",
        subtitles: [{ id: "1", url: "https://subs.example.invalid/1.srt", language: "eng" }],
      },
      { url: "https://cdn.example.invalid/film.m3u8", name: "", description: "Older add-on", subtitles: [] },
    ]);
  });

  it("mark streams whose sound is only DTS or TrueHD, which the TV plays silent", () => {
    const silent = [
      "Film.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.5.1-GRP",
      "Film 1080p BluRay x265 DTS",
      "Film.2019.UHD.TrueHD.7.1.Atmos",
      "Film [DTS:X 7.1]",
      "hevc10-dts",
    ];
    const heard = [
      "Film.2160p.WEB-DL.DDP5.1.Atmos.HEVC",
      "Film.1080p.BluRay.DTS-HD.MA.5.1.AC3.x264",
      "Film 1080p AAC 2.0",
      "Film.2160p.TrueHD.Atmos.7.1.E-AC-3",
      "Film.mkv",
      "Shorts.Stories.1080p",
    ];
    expect(silent.filter(name => !silentSound(name))).toEqual([]);
    expect(heard.filter(silentSound)).toEqual([]);

    const read = readStreams({
      streams: [
        { url: "http://cdn/a.mkv", name: "RD+ 4K", description: "Film.2160p.REMUX.TrueHD.7.1" },
        { url: "http://cdn/b.mkv", name: "RD+ 4K", behaviorHints: { filename: "Film.2160p.DTS-HD.MA.mkv" } },
        { url: "http://cdn/c.mkv", name: "RD+ 1080p", description: "Film.1080p.DDP5.1" },
      ],
    });
    expect(read.streams.map(stream => stream.silent)).toEqual([true, true, undefined]);
  });

  it("read subtitles with a web address", () => {
    expect(
      readSubtitlesAnswer({
        subtitles: [
          { id: "a", url: "https://subs.example.invalid/a.vtt", lang: "por" },
          { url: "https://subs.example.invalid/b.srt" },
          { id: "c", url: "file:///etc/passwd", lang: "eng" },
        ],
      }),
    ).toEqual([
      { id: "a", url: "https://subs.example.invalid/a.vtt", language: "por" },
      { id: "1", url: "https://subs.example.invalid/b.srt", language: "und" },
    ]);
  });
});
