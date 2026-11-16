import { describe, expect, it, vi } from "vitest";
import type { Tmdb } from "../stremio/tmdb";
import { createMoreLikeThis, SIMILAR_SHOWN } from "./moreLikeThis";

const fakeTmdb = () => {
  const recommendations = vi.fn<Tmdb["recommendations"]>(async (_type, id) =>
    Array.from({ length: 30 }, (_, at) => ({
      id: id * 100 + at,
      title: `Like ${id} ${at}`,
      originalTitle: "",
    })),
  );
  const byImdb = vi.fn<Tmdb["byImdb"]>(async (_type, imdb) => (imdb === "tt1" ? 11 : undefined));
  const title = vi.fn<Tmdb["title"]>(async (_type, id) => ({
    tmdb: id,
    name: "",
    genres: [],
    imdb: `tt${id}`,
  }));
  const tmdb = { recommendations, byImdb, title, search: async () => [] };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only what more-like-this uses
  return { tmdb: tmdb as unknown as Tmdb, recommendations, byImdb, title };
};

describe("more like this", () => {
  it("asks TMDB for a title's recommendations, by its TMDB or IMDb id, once", async () => {
    const fake = fakeTmdb();
    const similar = createMoreLikeThis({ tmdb: () => fake.tmdb });
    const found = await similar.of("movie", { imdb: "tt1" });
    expect(found).toHaveLength(SIMILAR_SHOWN);
    expect(found[0].title).toBe("Like 11 0");
    await similar.of("movie", { imdb: "tt1" });
    expect(fake.byImdb).toHaveBeenCalledTimes(1);
    expect(fake.recommendations).toHaveBeenCalledTimes(1);
    expect((await similar.of("series", { tmdb: 5 }))[0].id).toBe(500);
  });

  it("finds nothing without TMDB, an id, or a match", async () => {
    const fake = fakeTmdb();
    expect(await createMoreLikeThis({ tmdb: () => undefined }).of("movie", { tmdb: 5 })).toEqual([]);
    const similar = createMoreLikeThis({ tmdb: () => fake.tmdb });
    expect(await similar.of("movie", {})).toEqual([]);
    expect(await similar.of("movie", { imdb: "tt2" })).toEqual([]);
  });

  it("asks again after a failure, and gives a recommendation's IMDb id", async () => {
    const fake = fakeTmdb();
    fake.recommendations.mockRejectedValueOnce(new Error("offline"));
    const similar = createMoreLikeThis({ tmdb: () => fake.tmdb });
    await expect(similar.of("movie", { tmdb: 3 })).rejects.toThrow("offline");
    expect(await similar.of("movie", { tmdb: 3 })).toHaveLength(SIMILAR_SHOWN);
    expect(await similar.imdbOf("movie", 42)).toBe("tt42");
  });
});
