import { describe, expect, it } from "vitest";
import { memoryStorage } from "./memoryStorage";
import { MAX_WATCHED, createWatched } from "./watched";

const film = { key: "s/m:1", kind: "film" as const, title: "A film" };
const episode = (id: number, series = "s/s:1") => ({
  key: `s/e:${id}`,
  kind: "episode" as const,
  title: `Episode ${id}`,
  series,
  seriesName: "A show",
  season: 1,
  episode: id,
});

describe("where films were left", () => {
  it("keeps a film's place across a restart, unless barely begun or finished", () => {
    const storage = memoryStorage();
    let time = 1000;
    const watched = createWatched({ storage, now: () => time });
    watched.progress(film, 10_000, 360_000);
    expect(watched.resumeAt(film.key)).toBeUndefined();
    watched.progress(film, 120_000, 360_000);
    expect(createWatched({ storage }).resumeAt(film.key)).toBe(120_000);
    expect(watched.unfinishedFilms().map(entry => entry.key)).toEqual([film.key]);

    time = 2000;
    watched.progress(film, 350_000, 360_000);
    expect(watched.get(film.key)).toMatchObject({ finished: true, positionMs: 0, updatedAt: 2000 });
    expect(watched.resumeAt(film.key)).toBeUndefined();
    expect(watched.unfinishedFilms()).toEqual([]);
  });

  it("lists each series' newest episode, newest first", () => {
    let time = 0;
    const watched = createWatched({ storage: memoryStorage(), now: () => ++time });
    watched.progress(episode(1), 60_000, 360_000);
    watched.finish(episode(1));
    watched.progress(episode(2), 60_000, 360_000);
    watched.progress(episode(9, "s/s:2"), 60_000, 360_000);
    expect(watched.latestEpisodes().map(entry => entry.key)).toEqual(["s/e:9", "s/e:2"]);
    expect(watched.get("s/e:1")?.finished).toBe(true);
  });

  it("keeps only the newest entries, and reads restored ones carefully", () => {
    let time = 0;
    const watched = createWatched({ storage: memoryStorage(), now: () => ++time });
    for (let id = 0; id < MAX_WATCHED + 5; id++)
      watched.progress({ ...film, key: `s/m:${id}` }, 60_000, 360_000);
    expect(watched.all()).toHaveLength(MAX_WATCHED);
    expect(watched.all()[0].key).toBe(`s/m:${MAX_WATCHED + 4}`);

    watched.replace([
      { ...film, positionMs: 1, durationMs: 2, updatedAt: 1, finished: false },
      { ...film, title: "Again", updatedAt: 5 },
      { key: "x", kind: "song", title: "No" },
      "nonsense",
      { key: "s/m:2", kind: "film", title: "Newer", positionMs: -5, updatedAt: 9 },
    ]);
    expect(watched.all().map(entry => [entry.key, entry.positionMs])).toEqual([
      ["s/m:2", 0],
      ["s/m:1", 1],
    ]);
    watched.forgetSource("s");
    expect(watched.all()).toEqual([]);
  });
});
