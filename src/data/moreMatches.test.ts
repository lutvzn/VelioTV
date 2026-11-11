import { describe, expect, it } from "vitest";
import type { Tmdb, TmdbFound, TmdbTitle } from "../stremio/tmdb";
import { createMoreMatches, tmdbSearches } from "./moreMatches";
import type { MatchItem, TitleMatch } from "./titleMatches";

const film = (name: string, extra: Partial<MatchItem> = {}): MatchItem => ({
  key: `a/${name}`,
  source: "a",
  type: "movie",
  name,
  ...extra,
});

/** A TMDB that knows a few films, and what it was asked. */
const fakeTmdb = (
  films: (TmdbFound & { language?: string; imdb?: string; /** Also found by this. */ query?: string })[],
) => {
  const searches: string[] = [];
  const tmdb: Tmdb = {
    search: async (_type, query, options) => {
      const year = options?.year;
      const language = options?.language;
      searches.push(`${query}|${year ?? ""}|${language ?? ""}`);
      return films.filter(
        one =>
          (one.title === query || one.originalTitle === query || one.query === query) &&
          (year === undefined || one.year === year) &&
          (one.language === undefined || one.language === language),
      );
    },
    title: async (_type, id): Promise<TmdbTitle | undefined> => {
      const one = films.find(f => f.id === id);
      return one && { tmdb: one.id, imdb: one.imdb, name: one.title, year: one.year, genres: ["Drama"] };
    },
  };
  return { tmdb, searches };
};

const noWikidata = {
  imdbOfTmdb: async () => undefined,
  details: async () => undefined,
  providerTmdb: async () => undefined,
};

describe("createMoreMatches", () => {
  it("searches TMDB in the tag's language, and again without the year, taking the English name", async () => {
    const { tmdb, searches } = fakeTmdb([
      {
        id: 1,
        title: "Hold Your Breath",
        originalTitle: "Aguanta la respiración",
        year: 2024,
        language: "es",
        imdb: "tt1",
      },
      { id: 2, title: "Blood Bags", originalTitle: "Worki z krwia", year: 2018, imdb: "tt2" },
    ]);
    const more = createMoreMatches({ ...noWikidata, tmdb: () => tmdb });
    expect(await more.findMore(film("ES - Aguanta la respiración (2024)"), undefined)).toMatchObject({
      id: "tt1",
      name: "Hold Your Breath",
      via: "tmdbSearch",
    });
    // The category's tag, when the name has none; the year one off.
    expect(
      await more.findMore(film("Worki z krwia (2019)", { category: "PL | Filmy" }), undefined),
    ).toMatchObject({ id: "tt2" });
    expect(searches).toEqual([
      "Aguanta la respiración|2024|es",
      "Worki z krwia|2019|pl",
      "Worki z krwia||pl",
    ]);
  });

  it("asks the provider when TMDB's search finds nothing, one film at a time, and keeps a guess otherwise", async () => {
    const { tmdb } = fakeTmdb([
      { id: 7, title: "Tricked", originalTitle: "Tricked", year: 2000, imdb: "tt7" },
    ]);
    let atOnce = 0;
    let mostAtOnce = 0;
    const more = createMoreMatches({
      ...noWikidata,
      tmdb: () => tmdb,
      providerTmdb: async one => {
        mostAtOnce = Math.max(mostAtOnce, ++atOnce);
        await new Promise(resolve => setTimeout(resolve, 2));
        atOnce--;
        return one.name.startsWith("Einladung") ? 7 : undefined;
      },
    });
    const guess: TitleMatch = { id: "tt9", name: "Guess", genres: [], via: "guess" };
    const [found, kept, none] = await Promise.all([
      more.findMore(film("Einladung zum Mord", { askTmdb: true }), undefined),
      more.findMore(film("Avengers: Endgame (2019)", { askTmdb: true }), guess),
      more.findMore(film("M3U Film"), undefined),
    ]);
    expect(found).toMatchObject({ id: "tt7", name: "Tricked", via: "tmdb" });
    expect(kept).toBe(guess);
    expect(none).toBeUndefined();
    expect(mostAtOnce).toBe(1);
  });

  it("without TMDB, turns a TMDB id into Cinemeta's title through Wikidata", async () => {
    const more = createMoreMatches({
      tmdb: () => undefined,
      imdbOfTmdb: async (_type, id) => (id === 5 ? "tt5" : undefined),
      details: async (type, id) => ({ id, type, name: "Rain Over Lisbon", year: 2004, genres: ["Romance"] }),
      providerTmdb: async () => 5,
    });
    expect(await more.byTmdb("series", 5)).toMatchObject({
      id: "tt5",
      name: "Rain Over Lisbon",
      via: "tmdb",
    });
    expect(await more.byTmdb("series", 6)).toBeUndefined();
    expect(await more.findMore(film("Chuva", { askTmdb: true }), undefined)).toMatchObject({ id: "tt5" });
  });

  it("doesn't take a TMDB title without an IMDb id, as it can't be joined", async () => {
    const { tmdb } = fakeTmdb([{ id: 3, title: "Kilimanjara", originalTitle: "Kilimanjara", year: 2018 }]);
    const more = createMoreMatches({ ...noWikidata, tmdb: () => tmdb });
    expect(await more.findMore(film("Kilimanjara (2018)"), undefined)).toBeUndefined();
    expect(await more.byTmdb("movie", 3)).toBeUndefined();
  });

  it("searches by the cleaning's other names, and with the year as part of the name", async () => {
    expect(
      tmdbSearches("Harry-Potter-1-Harry-Potter-And-The-Philosopher-s-Stone (2001)").map(one => one.title),
    ).toContain("Harry Potter And The Philosopher's Stone");
    expect(tmdbSearches("Wonder-Woman (1984)")).toContainEqual({ title: "Wonder Woman 1984" });
    expect(tmdbSearches("Blade-Runner-2-Blade-Runner (2049)").map(one => one.title)).toContain(
      "Blade Runner 2049",
    );
    expect(tmdbSearches("Film").length).toBe(1);
    expect(tmdbSearches("A Very Long Name 2 Of A Film: With Parts (2001)").length).toBeLessThanOrEqual(6);

    const { tmdb } = fakeTmdb([
      { id: 1, title: "Wonder Woman", originalTitle: "Wonder Woman", year: 2017, imdb: "tt1" },
      { id: 2, title: "Wonder Woman 1984", originalTitle: "Wonder Woman 1984", year: 2020, imdb: "tt2" },
    ]);
    const more = createMoreMatches({ ...noWikidata, tmdb: () => tmdb });
    expect(await more.findMore(film("Wonder-Woman (1984)"), undefined)).toMatchObject({ id: "tt2" });
  });

  it("takes a name spelled a little differently only of the same year, and only one", async () => {
    const { tmdb } = fakeTmdb([
      {
        id: 1,
        title: "Baahubali: The Beginning",
        originalTitle: "Baahubali: The Beginning",
        year: 2015,
        imdb: "tt1",
        query: "Bāhubali The Beginning",
      },
      { id: 2, title: "How High", originalTitle: "How High", year: 2001, imdb: "tt2", query: "So High" },
    ]);
    const more = createMoreMatches({ ...noWikidata, tmdb: () => tmdb });
    expect(await more.findMore(film("Bāhubali The Beginning 2015"), undefined)).toMatchObject({
      id: "tt1",
      via: "tmdbClose",
    });
    expect(await more.findMore(film("Bāhubali The Beginning 2017"), undefined)).toBeUndefined();
    // A short name must be the same.
    expect(await more.findMore(film("So High (2001)"), undefined)).toBeUndefined();
  });

  it("doesn't take the provider's TMDB id when it's of another year and name", async () => {
    const { tmdb } = fakeTmdb([
      { id: 7, title: "The Notebook", originalTitle: "The Notebook", year: 2004, imdb: "tt7" },
    ]);
    const more = createMoreMatches({ ...noWikidata, tmdb: () => tmdb, providerTmdb: async () => 7 });
    expect(await more.findMore(film("Notebook 2019", { askTmdb: true }), undefined)).toBeUndefined();
    expect(await more.findMore(film("Notebook 2004", { askTmdb: true }), undefined)).toMatchObject({
      id: "tt7",
    });
  });

  it("stops once it's no longer wanted, and doesn't ask the provider", async () => {
    const { tmdb, searches } = fakeTmdb([]);
    let asked = 0;
    const more = createMoreMatches({
      ...noWikidata,
      tmdb: () => tmdb,
      providerTmdb: async () => {
        asked++;
        return undefined;
      },
    });
    expect(await more.findMore(film("Film (2001)", { askTmdb: true }), undefined, () => false)).toBeNull();
    expect(searches).toEqual([]);
    expect(asked).toBe(0);
  });
});
