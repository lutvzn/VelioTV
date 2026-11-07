import { afterEach, describe, expect, it, vi } from "vitest";
import { createNumberEntry, MISSING_MS } from "./numberEntry";

afterEach(() => vi.useRealTimers());

describe("number entry", () => {
  it("passes on the number after a pause, or at once on OK", () => {
    vi.useFakeTimers();
    const taken: number[] = [];
    const entry = createNumberEntry({ onNumber: n => taken.push(n) > 0, delayMs: 2000 });
    entry.digit(1);
    entry.digit(2);
    expect(entry.digits()).toBe("12");
    vi.advanceTimersByTime(2000);
    expect(taken).toEqual([12]);
    expect(entry.active()).toBe(false);

    entry.digit(7);
    entry.enter();
    expect(taken).toEqual([12, 7]);
  });

  it("shows a number nothing has for a moment", () => {
    vi.useFakeTimers();
    const entry = createNumberEntry({ onNumber: () => false });
    entry.digit(9);
    entry.enter();
    expect(entry.missing()).toBe("9");
    expect(entry.active()).toBe(true);
    vi.advanceTimersByTime(MISSING_MS);
    expect(entry.active()).toBe(false);
  });

  it("clears what was typed", () => {
    vi.useFakeTimers();
    const taken: number[] = [];
    const entry = createNumberEntry({ onNumber: n => taken.push(n) > 0 });
    entry.digit(4);
    entry.clear();
    vi.runAllTimers();
    expect(taken).toEqual([]);
    expect(entry.digits()).toBe("");
  });
});
