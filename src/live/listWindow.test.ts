import { describe, expect, it } from "vitest";
import { centredTop, clampIndex, scrollTop, wrapIndex } from "./listWindow";

describe("the list window", () => {
  it("scrolls only as far as the cursor needs", () => {
    expect(scrollTop(5, 0, 12, 100)).toBe(0);
    expect(scrollTop(12, 0, 12, 100)).toBe(1);
    expect(scrollTop(3, 10, 12, 100)).toBe(3);
    expect(scrollTop(99, 0, 12, 100)).toBe(88);
    // Shorter than the window.
    expect(scrollTop(4, 0, 12, 5)).toBe(0);
  });

  it("opens with the cursor in the middle, within the list", () => {
    expect(centredTop(50, 12, 100)).toBe(44);
    expect(centredTop(2, 12, 100)).toBe(0);
    expect(centredTop(98, 12, 100)).toBe(88);
    expect(centredTop(3, 12, 5)).toBe(0);
  });

  it("wraps or stops at the ends", () => {
    expect(wrapIndex(0, -1, 10)).toBe(9);
    expect(wrapIndex(9, 1, 10)).toBe(0);
    expect(wrapIndex(0, 1, 0)).toBe(0);
    expect(clampIndex(5, 12, 10)).toBe(9);
    expect(clampIndex(5, -12, 10)).toBe(0);
  });
});
