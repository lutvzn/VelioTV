import { describe, expect, it } from "vitest";
import { createTmdb, editsBetween, pickCloseTmdb, pickTmdb, readTmdbResults, readTmdbTitle } from "./tmdb";

describe("readTmdbResults", () => {
  it("reads films' and series' results, with their years", () => {
    expect(
      readTmdbResults(
        {
          results: [
            { id: 1, title: "Moana 2", original_title: "Moana 2", release_date: "2024-11-21" },
            { id: 2 },
          ],
        },
        "movie",
      ),
    ).toEqual([{ id: 1, title: "Moana 2", originalTitle: "Moana 2", year: 2024 }]);
    expect(
      readTmdbResults(
        { results: [{ id: 3, name: "Gomorrah", original_name: "Gomorra", first_air_date: "" }] },
        "series",
      ),
    ).toEqual([{ id: 3, title: "Gomorrah", originalTitle: "Gomorra" }]);
    expect(readTmdbResults(null, "movie")).toEqual([]);
  });
});

describe("readTmdbTitle", () => {
  it("gives the IMDb id, and genres as Cinemeta names them", () => {
    expect(
      readTmdbTitle(
        {
          id: 9,
          name: "The Expanse",
          first_air_date: "2015-12-14",
          poster_path: "/abc.jpg",
          genres: [{ name: "Sci-Fi & Fantasy" }, { name: "Drama" }, { name: "Action & Adventure" }],
          external_ids: { imdb_id: "tt3230854" },
        },
        "series",
      ),
    ).toEqual({
      tmdb: 9,
      imdb: "tt3230854",
      name: "The Expanse",
      year: 2015,
      genres: ["Sci-Fi", "Fantasy", "Drama", "Action", "Adventure"],
      poster: "https://image.tmdb.org/t/p/w342/abc.jpg",
    });
    expect(
      readTmdbTitle(
        { id: 1, title: "A", genres: [{ name: "Science Fiction" }, { name: "TV Movie" }] },
        "movie",
      ),
    ).toEqual({ tmdb: 1, name: "A", genres: ["Sci-Fi"] });
  });
});

describe("pickTmdb", () => {
  const found = [
    { id: 1, title: "The Crow", originalTitle: "The Crow", year: 1994 },
    { id: 2, title: "The Crow", originalTitle: "The Crow", year: 2024 },
    { id: 3, title: "Hold Your Breath", originalTitle: "Aguanta la respiración", year: 2024 },
  ];
  it("takes the same name, in English or its own language, with the nearest year", () => {
    expect(pickTmdb(found, "The Crow", 2025)?.id).toBe(2);
    expect(pickTmdb(found, "Aguanta la respiración", 2024)?.id).toBe(3);
    expect(pickTmdb(found, "The Crow", 2010)).toBeUndefined();
    expect(pickTmdb(found, "Crow", 2024)).toBeUndefined();
  });
  it("without a year, takes only a name no other result has", () => {
    expect(pickTmdb(found, "The Crow")).toBeUndefined();
    expect(pickTmdb(found, "Hold Your Breath")?.id).toBe(3);
  });
});

describe("createTmdb", () => {
  it("asks with the key and the search's year and language, a few at a time", async () => {
    const asked: string[] = [];
    let atOnce = 0;
    let mostAtOnce = 0;
    const fetcher: typeof fetch = async input => {
      asked.push(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
      mostAtOnce = Math.max(mostAtOnce, ++atOnce);
      await new Promise(resolve => setTimeout(resolve, 2));
      atOnce--;
      return new Response(JSON.stringify({ results: [] }));
    };
    const tmdb = createTmdb({
      key: () => "k",
      url: () => "https://tmdb.invalid/3",
      fetch: fetcher,
      atOnce: 2,
    });
    await Promise.all([
      tmdb.search("movie", "El cuervo", { year: 2024, language: "es" }),
      tmdb.search("series", "Gomorra"),
      tmdb.search("movie", "Three"),
    ]);
    expect(asked[0]).toBe(
      "https://tmdb.invalid/3/search/movie?query=El%20cuervo&year=2024&language=es&api_key=k",
    );
    expect(asked[1]).toBe("https://tmdb.invalid/3/search/tv?query=Gomorra&api_key=k");
    expect(mostAtOnce).toBe(2);
  });

  it("gives nothing for a title TMDB doesn't have, and fails when it can't answer", async () => {
    const answers = [new Response("", { status: 404 }), new Response("", { status: 429 })];
    const fetcher: typeof fetch = async () => answers.shift() ?? new Response("");
    const tmdb = createTmdb({ key: () => "k", fetch: fetcher });
    expect(await tmdb.title("movie", 1)).toBeUndefined();
    await expect(tmdb.title("movie", 2)).rejects.toThrow("HTTP 429");
  });
});

describe("pickCloseTmdb", () => {
  it("takes one name a letter or two off, of the same year", () => {
    expect(editsBetween("bahubali", "baahubali", 1)).toBe(1);
    expect(editsBetween("abc", "xyzabc", 1)).toBe(2);
    const found = [
      { id: 1, title: "Baahubali: The Beginning", originalTitle: "Baahubali: The Beginning", year: 2015 },
      { id: 2, title: "Baahubali 2: The Conclusion", originalTitle: "Baahubali 2", year: 2017 },
    ];
    expect(pickCloseTmdb(found, "Bāhubali The Beginning", 2015)?.id).toBe(1);
    expect(pickCloseTmdb(found, "Bāhubali The Beginning", 2016)).toBeUndefined();
    expect(
      pickCloseTmdb([{ id: 3, title: "How High", originalTitle: "How High", year: 2001 }], "So High", 2001),
    ).toBeUndefined();
  });
});
