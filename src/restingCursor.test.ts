import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_REST_MS, createRestingCursor } from "./restingCursor";

/** A cursor over a shown value, and what was opened through it. */
const make = (start = "a") =>
  createRoot(dispose => {
    const [shown, setShown] = createSignal(start);
    const opened: string[] = [];
    const cursor = createRestingCursor(shown, id => {
      opened.push(id);
      setShown(id);
    });
    return { cursor, shown, setShown, opened, dispose };
  });

describe("createRestingCursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens only where the cursor rests", () => {
    const { cursor, shown, opened, dispose } = make();
    cursor.move("b");
    vi.advanceTimersByTime(CURSOR_REST_MS - 50);
    cursor.move("c");
    vi.advanceTimersByTime(CURSOR_REST_MS - 50);
    expect(cursor.at()).toBe("c");
    expect(shown()).toBe("a");
    vi.advanceTimersByTime(50);
    expect(opened).toEqual(["c"]);
    expect(cursor.at()).toBe("c");
    dispose();
  });

  it("opens nothing when the cursor comes back to what's shown", () => {
    const { cursor, opened, dispose } = make();
    cursor.move("b");
    cursor.move("a");
    vi.advanceTimersByTime(CURSOR_REST_MS * 2);
    expect(opened).toEqual([]);
    dispose();
  });

  it("opens at once on settle", () => {
    const { cursor, opened, dispose } = make();
    cursor.move("b");
    expect(cursor.settle()).toBe("b");
    expect(cursor.settle()).toBeUndefined();
    vi.advanceTimersByTime(CURSOR_REST_MS * 2);
    expect(opened).toEqual(["b"]);
    dispose();
  });

  it("drops the move when what's shown changes in another way", () => {
    const { cursor, setShown, opened, dispose } = make();
    cursor.move("b");
    setShown("z");
    expect(cursor.at()).toBe("z");
    vi.advanceTimersByTime(CURSOR_REST_MS * 2);
    expect(opened).toEqual([]);
    dispose();
  });

  it("keeps a new move when what it opened arrives late", () => {
    const [shown, setShown] = createSignal("a");
    const { cursor, dispose } = createRoot(close => ({
      // Opens later, as the router does.
      cursor: createRestingCursor(shown, () => undefined),
      dispose: close,
    }));
    cursor.move("b");
    cursor.settle();
    cursor.move("c");
    setShown("b");
    expect(cursor.at()).toBe("c");
    dispose();
  });

  it("stops when its owner goes", () => {
    const { cursor, opened, dispose } = make();
    cursor.move("b");
    dispose();
    vi.advanceTimersByTime(CURSOR_REST_MS * 2);
    expect(opened).toEqual([]);
  });
});
