import { describe, expect, it, vi } from "vitest";
import type { Episode, SeriesDetails } from "../data/vod";
import { hasAired, nextEpisode } from "./vodPlay";

vi.mock("../library", () => ({}));

const episode = (season: number, number: number, released?: number): Episode => ({
  id: `e:${season}-${number}`,
  season,
  episode: number,
  title: "",
  url: "",
  ...(released === undefined ? {} : { released }),
});

const DAY = 86_400_000;
const NOW = 100 * DAY;

describe("the next episode", () => {
  const details: SeriesDetails = {
    seasons: [
      { season: 0, episodes: [episode(0, 1), episode(0, 2)] },
      { season: 1, episodes: [episode(1, 1, NOW - DAY), episode(1, 2), episode(1, 3, NOW + DAY)] },
    ],
  };
  const [special1, special2, first, second, third] = details.seasons.flatMap(season => season.episodes);

  it("counts one with no date, or a past date, as on", () => {
    expect(hasAired(first, NOW)).toBe(true);
    expect(hasAired(second, NOW)).toBe(true);
    expect(hasAired(third, NOW)).toBe(false);
    expect(hasAired({ ...first, released: Number.NaN }, NOW)).toBe(true);
  });

  it("goes on in order, a special only to a special, and not to one still to come", () => {
    expect(nextEpisode(details, first, NOW)?.id).toBe(second.id);
    expect(nextEpisode(details, special1, NOW)?.id).toBe(special2.id);
    expect(nextEpisode(details, special2, NOW)).toBeUndefined();
    expect(nextEpisode(details, second, NOW)).toBeUndefined();
    expect(nextEpisode(details, second, NOW + 2 * DAY)?.id).toBe(third.id);
    expect(nextEpisode(details, { ...first, id: "e:gone" }, NOW)).toBeUndefined();
  });
});
