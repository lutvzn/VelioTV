import { describe, expect, it } from "vitest";
import type { Film, Series } from "./vod";
import { fromVodColumns, toVodColumns } from "./vodColumns";

const films: Film[] = [
  { id: "m:1", name: "One", url: "http://a/movie/u/p/1.mp4", category: "Drama", year: 1999, providerId: "1" },
  {
    id: "m:2",
    name: "Two",
    url: "http://a/2.mkv",
    poster: "http://a/2.jpg",
    headers: { referer: "http://a/" },
    rating: 7.5,
    added: 1_700_000_000_000,
  },
];

const series: Series[] = [
  {
    id: "s:show",
    name: "Show",
    category: "Comedy",
    episodes: [
      { id: "e:1", season: 1, episode: 1, title: "Pilot", url: "http://a/s1e1.mp4" },
      {
        id: "e:2",
        season: 1,
        episode: 2,
        title: "",
        url: "http://a/s1e2.mp4",
        headers: { userAgent: "x" },
      },
    ],
  },
  // From Xtream: episodes come when it's opened.
  {
    id: "s:9",
    name: "Nine",
    poster: "http://a/9.jpg",
    rating: 8,
    year: 2020,
    plot: "Nine.",
    providerId: "9",
  },
  {
    id: "s:other",
    name: "Other",
    episodes: [{ id: "e:3", season: 2, episode: 5, title: "Late", url: "u", plot: "p", durationMs: 60_000 }],
  },
  { id: "s:empty", name: "Empty", episodes: [] },
];

describe("film and series columns", () => {
  it("give back the same films and series", () => {
    expect(fromVodColumns(toVodColumns({ films, series }))).toEqual({ films, series });
  });

  it("keep no column for a field nothing has", () => {
    const columns = toVodColumns({ films: [{ id: "m:1", name: "One", url: "u" }], series: [] });
    expect(Object.keys(columns.films.columns)).toEqual(["id", "name", "url"]);
    expect(columns.series.columns).toEqual({});
    expect(columns.episodes.count).toBe(0);
  });

  it("are few arrays, not an object an item", () => {
    const columns = toVodColumns({ films, series });
    expect(columns.episodes.columns.id).toEqual(["e:1", "e:2", "e:3"]);
    expect(columns.series.columns.episodes).toEqual([2, null, 1, 0]);
    expect(columns.films.columns.poster).toEqual([null, "http://a/2.jpg"]);
  });

  it("are empty for no films or series", () => {
    expect(fromVodColumns(toVodColumns({ films: [], series: [] }))).toEqual({ films: [], series: [] });
  });
});
