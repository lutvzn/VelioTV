import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeeker, SEEK_DELAY_MS } from "./seeker";

describe("seeking", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("adds up presses, with growing steps, and jumps once they stop", () => {
    const jumps: number[] = [];
    const seeker = createSeeker({
      position: () => 600_000,
      min: () => 0,
      max: () => 3_600_000,
      commit: at => jumps.push(at),
    });
    seeker.press(1);
    seeker.press(1);
    seeker.press(1);
    expect(seeker.target()).toBe(690_000);
    seeker.press(1);
    expect(seeker.target()).toBe(750_000);
    vi.advanceTimersByTime(SEEK_DELAY_MS - 1);
    expect(jumps).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(jumps).toEqual([750_000]);
    expect(seeker.target()).toBeUndefined();
  });

  it("starts the steps over when the direction changes, and stays within the ends", () => {
    const jumps: number[] = [];
    const seeker = createSeeker({
      position: () => 20_000,
      min: () => 0,
      max: () => 100_000,
      commit: at => jumps.push(at),
    });
    seeker.press(1);
    seeker.press(-1);
    seeker.press(-1);
    expect(seeker.target()).toBe(0);
    for (let n = 0; n < 12; n++) seeker.press(1);
    expect(seeker.target()).toBe(100_000);
    seeker.cancel();
    vi.advanceTimersByTime(SEEK_DELAY_MS);
    expect(jumps).toEqual([]);
    // A bigger first step, as Fast forward takes.
    seeker.press(1, 4);
    seeker.finish();
    expect(jumps).toEqual([80_000]);
  });
});
