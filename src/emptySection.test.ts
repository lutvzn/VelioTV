import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { markEmpty, sectionEmpty } from "./emptySection";

/** Opens a page that marks itself empty while `empty` is true; returns its close. */
const page = (empty: () => boolean) =>
  createRoot(dispose => {
    markEmpty(empty);
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
});
