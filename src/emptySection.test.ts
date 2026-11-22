import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { markEmpty, sectionEmpty, startPlace, type StartPlace } from "./emptySection";

/** Opens a page that marks itself empty while `empty` is true; returns its close. */
const page = (empty: () => boolean, start?: () => StartPlace | undefined) =>
  createRoot(dispose => {
    markEmpty(empty, start);
    return dispose;
  });

describe("markEmpty", () => {
  it("follows the page, and clears when it closes", () => {
    const [empty, setEmpty] = createSignal(true);
    const close = page(empty);
    expect(sectionEmpty()).toBe(true);
    setEmpty(false);
    expect(sectionEmpty()).toBe(false);
    setEmpty(true);
    expect(sectionEmpty()).toBe(true);
    close();
    expect(sectionEmpty()).toBe(false);
  });

  it("isn't cleared by the page before closing after the next one opens", () => {
    const closeOld = page(() => true);
    const closeNew = page(() => true);
    closeOld();
    expect(sectionEmpty()).toBe(true);
    closeNew();
    expect(sectionEmpty()).toBe(false);
  });

  it("offers ways to get started only while empty, and where the page says", () => {
    const [empty, setEmpty] = createSignal(true);
    const [loading, setLoading] = createSignal(true);
    const close = page(empty, () => (loading() ? undefined : { x: 10, y: 20 }));
    // Empty while it loads, with nothing offered yet.
    expect(sectionEmpty()).toBe(true);
    expect(startPlace()).toBeUndefined();
    setLoading(false);
    expect(startPlace()).toEqual({ x: 10, y: 20 });
    setEmpty(false);
    expect(sectionEmpty()).toBe(false);
    expect(startPlace()).toBeUndefined();
    setEmpty(true);
    expect(startPlace()).toEqual({ x: 10, y: 20 });
    close();
    expect(startPlace()).toBeUndefined();
  });
});
