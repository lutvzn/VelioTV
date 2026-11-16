import { describe, expect, it } from "vitest";
import { nextFileName, sameFileName, seasonEpisodeOf } from "./episodeFile";

describe("an episode's file name", () => {
  it("gives its season and episode", () => {
    expect(seasonEpisodeOf("Show.S02E07.1080p.mkv")).toEqual({ season: 2, episode: 7 });
    expect(seasonEpisodeOf("Show 3x12 HDTV")).toEqual({ season: 3, episode: 12 });
    expect(seasonEpisodeOf("Show - E05")).toEqual({ season: undefined, episode: 5 });
    expect(seasonEpisodeOf("Film.2019.1080p.mkv")).toBeUndefined();
  });

  it("gives the next episode's name, keeping the zeros", () => {
    expect(nextFileName("Show.S01E09.WEB.mkv", 1, 10)).toBe("Show.S01E10.WEB.mkv");
    expect(nextFileName("Show.S01E10.WEB.mkv", 2, 1)).toBe("Show.S02E01.WEB.mkv");
    expect(nextFileName("Show 1x03.mkv", 1, 4)).toBe("Show 1x04.mkv");
    expect(nextFileName("Show EP03.mkv", 1, 4)).toBe("Show EP04.mkv");
    expect(nextFileName("Film.2019.mkv", 1, 2)).toBeUndefined();
  });

  it("compares names ignoring case, never matching an empty one", () => {
    expect(sameFileName("Show.S01E02.mkv", "show.s01e02.MKV")).toBe(true);
    expect(sameFileName("", "")).toBe(false);
    expect(sameFileName(undefined, "a")).toBe(false);
  });
});
