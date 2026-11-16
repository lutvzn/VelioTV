import { describe, expect, it } from "vitest";
import { finishedNaturally, isShortClip, nextCardShown, SHORT_CLIP_MS } from "./playEnd";

describe("the end of a film or episode", () => {
  it("takes streams up to 2:01 for placeholder clips", () => {
    expect(isShortClip(30_000)).toBe(true);
    expect(isShortClip(SHORT_CLIP_MS)).toBe(true);
    expect(isShortClip(SHORT_CLIP_MS + 1)).toBe(false);
    expect(isShortClip(0)).toBe(false);
    expect(isShortClip(Number.NaN)).toBe(false);
  });

  it("counts as finished only after a picture, without failing, and not a short clip", () => {
    const end = { showedPicture: true, failed: false, durationMs: 40 * 60_000 };
    expect(finishedNaturally(end)).toBe(true);
    expect(finishedNaturally({ ...end, showedPicture: false })).toBe(false);
    expect(finishedNaturally({ ...end, failed: true })).toBe(false);
    expect(finishedNaturally({ ...end, durationMs: 20_000 })).toBe(false);
  });

  it("shows the next episode's card at a share of it, or seconds before its end", () => {
    const length = 40 * 60_000;
    expect(nextCardShown("99%", length * 0.98, length)).toBe(false);
    expect(nextCardShown("99%", length * 0.99, length)).toBe(true);
    expect(nextCardShown("60s", length - 61_000, length)).toBe(false);
    expect(nextCardShown("60s", length - 60_000, length)).toBe(true);
    expect(nextCardShown("off", length, length)).toBe(false);
    expect(nextCardShown("99%", 60_000, 60_000)).toBe(false);
    expect(nextCardShown("99%", 0, 0)).toBe(false);
  });
});
