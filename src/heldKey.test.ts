import { releaseKeySuppression } from "@solidtv/solid/primitives";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_DELAY_MS, heldMoves, holding, moveWhileHeld, stopHold } from "./heldKey";

const TOP = 20;
const DOWN = 40;
const UP = 38;
const press = (keyCode: number) => new KeyboardEvent("keydown", { keyCode });

/** A cursor from 0 to `last`, and what moved it. */
const cursor = (last = 1000) => {
  const state = { at: 0, moves: [] as number[] };
  const move = (by: number) => {
    const to = Math.max(0, Math.min(last, state.at + by));
    if (to === state.at) return false;
    state.moves.push(by);
    state.at = to;
    return true;
  };
  return { state, move };
};

describe("heldMoves", () => {
  it("waits, then speeds up to the top speed", () => {
    expect(heldMoves(HOLD_DELAY_MS - 1, TOP)).toBe(0);
    expect(heldMoves(HOLD_DELAY_MS, TOP)).toBe(1);
    const firstSecond = heldMoves(HOLD_DELAY_MS + 1000, TOP);
    const secondSecond = heldMoves(HOLD_DELAY_MS + 2000, TOP) - firstSecond;
    expect(firstSecond).toBeGreaterThan(5);
    expect(secondSecond).toBeGreaterThan(firstSecond);
    for (const top of [20, 60]) {
      expect(heldMoves(HOLD_DELAY_MS + 11_000, top) - heldMoves(HOLD_DELAY_MS + 10_000, top)).toBe(top);
    }
  });

  it("keeps a top under the start speed from the start", () => {
    expect(heldMoves(HOLD_DELAY_MS + 1000, 5)).toBe(6);
    expect(heldMoves(HOLD_DELAY_MS + 2000, 5)).toBe(11);
  });
});

describe("moveWhileHeld", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
  });
  afterEach(() => {
    stopHold();
    vi.useRealTimers();
  });

  it("moves once for a press, then by itself while held, faster and faster", () => {
    const { state, move } = cursor();
    const event = press(DOWN);
    moveWhileHeld(event, 1, TOP, move);
    expect(state.at).toBe(1);
    vi.advanceTimersByTime(HOLD_DELAY_MS - 50);
    expect(state.at).toBe(1);
    vi.advanceTimersByTime(1050);
    const afterOne = state.at;
    expect(afterOne).toBe(1 + heldMoves(HOLD_DELAY_MS + 1000, TOP));
    vi.advanceTimersByTime(1000);
    expect(state.at - afterOne).toBeGreaterThan(afterOne);
    releaseKeySuppression(event);
    const released = state.at;
    vi.advanceTimersByTime(1000);
    expect(state.at).toBe(released);
    expect(holding()).toBe(false);
  });

  it("starts slow again when the key is pressed again just after its release", () => {
    const { state, move } = cursor();
    const first = press(DOWN);
    moveWhileHeld(first, 1, TOP, move);
    vi.advanceTimersByTime(HOLD_DELAY_MS + 3000);
    releaseKeySuppression(first);
    expect(holding()).toBe(false);
    vi.advanceTimersByTime(50);
    const before = state.at;
    moveWhileHeld(press(DOWN), 1, TOP, move);
    expect(state.at).toBe(before + 1);
    vi.advanceTimersByTime(HOLD_DELAY_MS - 50);
    expect(state.at).toBe(before + 1);
  });

  it("starts again for a press after a pause, or for the other key", () => {
    const { state, move } = cursor();
    const first = press(DOWN);
    moveWhileHeld(first, 1, TOP, move);
    releaseKeySuppression(first);
    moveWhileHeld(press(DOWN), 1, TOP, move);
    expect(state.at).toBe(2);
    moveWhileHeld(press(UP), -1, TOP, move);
    expect(state.at).toBe(1);
  });

  it("stops at the end", () => {
    const { state, move } = cursor(10);
    moveWhileHeld(press(DOWN), 1, TOP, move);
    vi.advanceTimersByTime(5000);
    expect(state.at).toBe(10);
    expect(holding()).toBe(false);
  });
});
