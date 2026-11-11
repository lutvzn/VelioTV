// Which Movies and Series layout a profile uses (PLAN.md, "Movies and Series
// by title", step 6): modern, with every source's copy of a title as one,
// by Cinemeta's genres, or classic, by each source's categories. Modern by
// default; each profile keeps its own choice (src/data/profiles.ts).

import { createMemo, createRoot, createSignal } from "solid-js";

export type VodLayout = "modern" | "classic";
export const VOD_LAYOUT_KEY = "velio.vodLayout";

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
    return {
      layout,
      modern: () => layout() === "modern",
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
