import { describe, expect, it } from "vitest";
import { DEFAULT_PLAY_CHOICES } from "../data/playChoices";
import { autoPick, autoPlayable, createMatcher, excludedWords } from "./autoPlay";

const rows = (...texts: [string, boolean][]) =>
  texts.map(([text, settled], at) => ({ choice: at, text, settled }));

describe("auto-play", () => {
  it("reads the words a pattern leaves out, with the excluded field's", () => {
    expect(excludedWords("^(?!.*(CAM|TS)).*1080p", "SCR, HDTS")).toEqual(["CAM", "TS", "SCR", "HDTS"]);
    expect(excludedWords("1080p", "")).toEqual([]);
  });

  it("matches a pattern, or the words as typed when it isn't one, without the excluded words", () => {
    const matches = createMatcher({ pattern: "2160p|1080p", exclude: "CAM|TS" });
    expect(matches("Film.1080p.WEB")).toBe(true);
    expect(matches("Film.1080p.TS")).toBe(false);
    expect(matches("Film.720p.WEB")).toBe(false);
    // "TS" as a word, not inside one.
    expect(matches("Film.1080p.HEVC.Tsunami")).toBe(true);
    expect(createMatcher({ pattern: "(1080p", exclude: "" })("Film (1080p")).toBe(true);
    expect(createMatcher({ pattern: "", exclude: "" })("anything")).toBe(true);
  });

  it("plays nothing when off, every row for the first, and the matching ones for a pattern", () => {
    const list = rows(["Film 720p", true], ["Film 1080p", true]);
    expect(autoPlayable(list, DEFAULT_PLAY_CHOICES)).toEqual([]);
    expect(autoPlayable(list, { ...DEFAULT_PLAY_CHOICES, autoPlay: "first" })).toHaveLength(2);
    expect(
      autoPlayable(list, { ...DEFAULT_PLAY_CHOICES, autoPlay: "pattern" }).map(row => row.choice),
    ).toEqual([1]);
  });

  it("picks only once nothing could still come before it", () => {
    const choices = { ...DEFAULT_PLAY_CHOICES, autoPlay: "pattern" as const };
    expect(autoPick(rows(["Film 720p", true], ["Film 1080p", false]), choices)).toBeUndefined();
    expect(autoPick(rows(["Film 720p", true], ["Film 1080p", true]), choices)?.choice).toBe(1);
    expect(autoPick(rows(["Film 720p", true]), choices)).toBeUndefined();
  });
});
