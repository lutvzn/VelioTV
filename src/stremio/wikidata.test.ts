import { describe, expect, it } from "vitest";
import { createWikidata, readWikidata, wikidataQuery } from "./wikidata";

const URL = "https://wikidata.example.invalid/sparql";

/** A SPARQL endpoint that knows `known`, and the queries it was asked. */
const endpoint = (known: Record<string, string>, fail = false) => {
  const queries: string[] = [];
  let atOnce = 0;
  let mostAtOnce = 0;
  const fetcher: typeof fetch = async input => {
    const query =
      new globalThis.URL(input instanceof Request ? input.url : input).searchParams.get("query") ?? "";
    queries.push(query);
    mostAtOnce = Math.max(mostAtOnce, ++atOnce);
    await new Promise(resolve => setTimeout(resolve, 2));
    atOnce--;
    if (fail) return new Response("busy", { status: 429 });
    const ids = (query.match(/"\d+"/g) ?? []).map(id => id.slice(1, -1));
    const bindings = ids
      .filter(id => known[id])
      .map(id => ({ tmdb: { value: id }, imdb: { value: known[id] } }));
    return new Response(JSON.stringify({ results: { bindings } }));
  };
  return { fetcher, queries, mostAtOnce: () => mostAtOnce };
};

describe("wikidataQuery", () => {
  it("asks for films' and series' TMDB ids by their own property", () => {
    expect(wikidataQuery("movie", [63, 64])).toContain('VALUES ?tmdb { "63" "64" }');
    expect(wikidataQuery("movie", [63])).toContain("wdt:P4947 ?tmdb");
    expect(wikidataQuery("series", [1])).toContain("wdt:P4983 ?tmdb");
  });
});

describe("readWikidata", () => {
  it("takes the first IMDb id for each TMDB id, and leaves out junk", () => {
    const found = readWikidata({
      results: {
        bindings: [
          { tmdb: { value: "63" }, imdb: { value: "tt0114746" } },
          { tmdb: { value: "63" }, imdb: { value: "tt9999999" } },
          { tmdb: { value: "64" }, imdb: { value: "nm0000001" } },
          { tmdb: { value: "x" }, imdb: { value: "tt0000001" } },
        ],
      },
    });
    expect([...found]).toEqual([[63, "tt0114746"]]);
    expect(readWikidata(undefined).size).toBe(0);
  });
});

describe("createWikidata", () => {
  it("asks for the ids wanted within a moment in one query, and each once", async () => {
    const server = endpoint({ "63": "tt0114746", "65": "tt0000065" });
    const wikidata = createWikidata({ url: () => URL, fetch: server.fetcher, waitMs: 5 });
    const found = await Promise.all([63, 64, 65, 63].map(id => wikidata.imdbOf("movie", id)));
    expect(found).toEqual(["tt0114746", undefined, "tt0000065", "tt0114746"]);
    expect(server.queries).toHaveLength(1);
    await wikidata.imdbOf("movie", 64);
    expect(server.queries).toHaveLength(1);
  });

  it("splits many ids into queries asked one at a time, films apart from series", async () => {
    const server = endpoint({ "1": "tt0000001" });
    const wikidata = createWikidata({ url: () => URL, fetch: server.fetcher, waitMs: 5, most: 2 });
    const films = [1, 2, 3, 4, 5].map(id => wikidata.imdbOf("movie", id));
    const show = wikidata.imdbOf("series", 1);
    expect(await Promise.all(films)).toEqual(["tt0000001", undefined, undefined, undefined, undefined]);
    expect(await show).toBe("tt0000001");
    expect(server.queries).toHaveLength(4);
    expect(server.queries.filter(query => query.includes("P4983"))).toHaveLength(1);
    expect(server.mostAtOnce()).toBe(1);
  });

  it("fails when Wikidata can't answer, and asks again next time", async () => {
    const server = endpoint({}, true);
    const wikidata = createWikidata({ url: () => URL, fetch: server.fetcher, waitMs: 5 });
    await expect(wikidata.imdbOf("movie", 63)).rejects.toThrow("HTTP 429");
    await expect(wikidata.imdbOf("movie", 63)).rejects.toThrow("HTTP 429");
    expect(server.queries).toHaveLength(2);
  });
});
