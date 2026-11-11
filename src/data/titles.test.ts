import { describe, expect, it } from "vitest";
import type { SeriesDetails } from "./vod";
import type { FilmEntry, SeriesEntry } from "./vodLibrary";
import { createFilmMerger, mergeEpisodes, mergeFilms, mergeSeries, type AddonItem } from "./titles";
import type { MatchChanges, TitleMatch } from "./titleMatches";

const film = (source: string, id: string, name: string, extra: Partial<FilmEntry> = {}): FilmEntry => ({
  id,
  name,
  url: `http://example.invalid/${source}/${id}.mp4`,
  source,
  key: `${source}/${id}`,
  ...extra,
});

const adventure: TitleMatch = {
  id: "tt0000001",
  name: "The Great Adventure",
  year: 1999,
  genres: ["Adventure", "Drama"],
};

const matchOf = (item: { key: string }) => (item.key === "b/m:8" ? undefined : adventure);

const show = (source: string, id: string): SeriesEntry => ({
  id,
  name: "Harbour Lights",
  source,
  key: `${source}/${id}`,
});
const episode = (season: number, number: number, id: string) => ({
  id,
  season,
  episode: number,
  title: `S${season}E${number}`,
  url: `http://example.invalid/${id}.mp4`,
});

describe("mergeFilms", () => {
  it("joins the sources' copies of a matched film, and the add-ons' title of its id", () => {
    const films = [
      film("a", "m:1", "EN - The Great Adventure (1999)", { category: "Films A" }),
      film("b", "m:7", "The Great Adventure 1999 FHD", { category: "Films B" }),
      film("b", "m:8", "Lonely Film", { category: "Films B" }),
    ];
    const merged = mergeFilms(films, matchOf, [
      { meta: { id: "tt0000001", type: "movie", name: "The Great Adventure", poster: "p.jpg" }, addon: "x" },
      { meta: { id: "tt0000002", type: "movie", name: "Addon Only", genres: ["Comedy"] }, addon: "x" },
    ]);
    expect(merged.titles.map(one => one.name)).toEqual(["The Great Adventure", "Lonely Film", "Addon Only"]);
    const [title, lonely, addon] = merged.titles;
    expect(title.key).toBe("stremio:movie:tt0000001");
    expect(title.links.map(one => one.key)).toEqual(["a/m:1", "b/m:7"]);
    expect(title.genres).toEqual(["Adventure", "Drama"]);
    expect(title.poster).toBe("p.jpg");
    expect(merged.byKey.get("b/m:7")).toBe(title);
    expect(lonely.links.map(one => one.key)).toEqual(["b/m:8"]);
    expect(lonely.category).toBe("Films B");
    expect(addon.links).toEqual([]);
    expect(addon.genres).toEqual(["Comedy"]);
    expect(merged.byImdb.get("tt0000002")).toBe(addon);
  });

  it("joins unmatched copies with the same cleaned name and year", () => {
    const merged = mergeFilms(
      [
        film("a", "m:1", "Night Train (2004)"),
        film("b", "m:2", "NIGHT TRAIN 2004 HD"),
        film("b", "m:3", "Night Train (1950)"),
      ],
      () => undefined,
    );
    expect(merged.titles.map(one => one.links.length)).toEqual([2, 1]);
  });
});

describe("mergeSeries and mergeEpisodes", () => {
  it("joins every copy's episodes by season and number", () => {
    const merged = mergeSeries([show("a", "s:1"), show("b", "s:2")], () => ({
      ...adventure,
      id: "tt0900001",
    }));
    expect(merged.titles).toHaveLength(1);
    const [a, b] = merged.titles[0].links;
    const base: SeriesDetails = {
      plot: "From Cinemeta",
      seasons: [
        { season: 1, episodes: [{ ...episode(1, 1, "e:tt0900001:1:1"), url: "", stremio: "tt0900001:1:1" }] },
      ],
    };
    const details = mergeEpisodes(base, [
      {
        show: a,
        details: { seasons: [{ season: 1, episodes: [episode(1, 1, "a1"), episode(1, 2, "a2")] }] },
      },
      {
        show: b,
        details: {
          seasons: [
            { season: 0, episodes: [episode(0, 1, "b0")] },
            { season: 1, episodes: [episode(1, 1, "b1")] },
          ],
        },
      },
    ]);
    expect(details.plot).toBe("From Cinemeta");
    expect(details.seasons.map(one => one.season)).toEqual([1, 0]);
    const [first, second] = details.seasons[0].episodes;
    expect(first.stremio).toBe("tt0900001:1:1");
    expect(first.links?.map(link => link.episode.id)).toEqual(["a1", "b1"]);
    expect(second.id).toBe("a2");
    expect(second.links?.map(link => link.show.source)).toEqual(["a"]);
  });
});

describe("createFilmMerger", () => {
  it("joins again only what changed, giving what mergeFilms() gives", () => {
    // A small random world, the same each run: few names and ids, so titles join and split.
    let seed = 7;
    const random = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
    const names = ["Rain (2004)", "Rain (2005)", "Harbour", "Lights (1999)", "Other"];
    const films = Array.from({ length: 60 }, (_, i) =>
      film(pick(["a", "b"]), `m:${i}`, pick(names), random() < 0.3 ? { poster: `p${i}` } : {}),
    );
    const metas = ["tt1", "tt2", "tt3", "tt4"].map(id => ({
      id,
      type: "movie",
      name: `Title ${id}`,
      genres: id === "tt4" ? ["Drama"] : undefined,
    }));
    const items: AddonItem[] = [
      { meta: metas[0], addon: "x" },
      { meta: metas[3], addon: "x" },
      { meta: { id: "x:9", type: "movie", name: "Only here" }, addon: "x" },
      { meta: metas[3], addon: "y" },
    ];
    const matches = new Map<string, TitleMatch>();
    const matchFor = (item: { key: string }) => matches.get(item.key);
    const log: string[] = [];
    const changes = (): MatchChanges => ({ id: 1, keys: log });
    const merger = createFilmMerger();
    const same = () => {
      const want = mergeFilms(films, matchFor, items);
      const got = merger(films, matchFor, items, changes());
      expect(got.titles).toEqual(want.titles);
      for (const one of films) expect(got.byKey.get(one.key)).toEqual(want.byKey.get(one.key));
      expect(new Set(got.byImdb.keys())).toEqual(new Set(want.byImdb.keys()));
      return got;
    };
    same();
    for (let step = 0; step < 40; step++) {
      for (let n = 0; n < 3; n++) {
        const one = pick(films);
        const id = pick(["tt1", "tt2", "tt3", "tt4", ""]);
        if (id) matches.set(one.key, { id, name: `Title ${id}`, genres: random() < 0.5 ? ["Drama"] : [] });
        else matches.delete(one.key);
        log.push(one.key);
      }
      const before = merger(films, matchFor, items, changes()).titles;
      log.push(pick(films).key);
      const after = same();
      // Titles whose copies' matches didn't change are the same objects.
      expect(after.titles.filter(title => before.includes(title)).length).toBeGreaterThan(0);
    }
  });
});
