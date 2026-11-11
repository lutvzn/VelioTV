// Which Movies and Series layout a profile uses (PLAN.md, "Movies and Series
// by title", step 6): modern, with every source's copy of a title as one,
// by Cinemeta's genres, or classic, by each source's categories. Modern by
// default; each profile keeps its own choice (src/data/profiles.ts).

import { createMemo, createRoot, createSignal } from "solid-js";

export type VodLayout = "modern" | "classic";
export const VOD_LAYOUT_KEY = "velio.vodLayout";
/**
 * Which titles the modern layout shows in their providers' categories:
 * only those it couldn't match (the default), or every title, so a
 * provider's "Kids" or "Turkish films" stays whole.
 */
export type VodCategories = "unmatched" | "all";
export const VOD_CATEGORIES_KEY = "velio.vodCategories";

export const createVodLayout = (options: { storage: Storage; profile: () => string | undefined }) =>
  createRoot(() => {
    const [saved, setSaved] = createSignal(0);
    const layout = createMemo((): VodLayout => {
      options.profile();
      saved();
      try {
        return options.storage.getItem(VOD_LAYOUT_KEY) === "classic" ? "classic" : "modern";
      } catch {
        return "modern";
      }
    });
    const categories = createMemo((): VodCategories => {
      options.profile();
      saved();
      try {
        return options.storage.getItem(VOD_CATEGORIES_KEY) === "all" ? "all" : "unmatched";
      } catch {
        return "unmatched";
      }
    });
    return {
      layout,
      modern: () => layout() === "modern",
      categories,
      setCategories: (next: VodCategories) => {
        try {
          options.storage.setItem(VOD_CATEGORIES_KEY, next);
        } catch (error) {
          console.warn("Couldn't keep the categories setting:", error);
        }
        setSaved(n => n + 1);
      },
      set: (next: VodLayout) => {
        try {
          options.storage.setItem(VOD_LAYOUT_KEY, next);
        } catch (error) {
          console.warn("Couldn't keep the layout:", error);
        }
        setSaved(n => n + 1);
      },
    };
  });
