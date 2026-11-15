// The Movies and Series groups pinned at the top of the page's column, over
// Continue watching, chosen by holding OK on a group or with the Tools key.
// Each profile keeps its own (src/data/profiles.ts), by page, in the order
// they were pinned.

import { createMemo, createRoot, createSignal } from "solid-js";

export const VOD_PINS_KEY = "velio.vodPins";

type Pins = Record<string, string[]>;

const read = (storage: Storage): Pins => {
  try {
    const value: unknown = JSON.parse(storage.getItem(VOD_PINS_KEY) ?? "{}");
    if (typeof value !== "object" || value === null) return {};
    const pins: Pins = {};
    for (const [page, groups] of Object.entries(value)) {
      if (!Array.isArray(groups)) continue;
      pins[page] = [...new Set(groups.filter((group): group is string => typeof group === "string"))];
    }
    return pins;
  } catch {
    return {};
  }
};

export const createVodPins = (options: { storage: Storage; profile: () => string | undefined }) =>
  createRoot(() => {
    const [saved, setSaved] = createSignal(0);
    const pins = createMemo(() => {
      options.profile();
      saved();
      return read(options.storage);
    });
    const write = (page: string, groups: string[]) => {
      const next = read(options.storage);
      next[page] = [...new Set(groups)];
      try {
        options.storage.setItem(VOD_PINS_KEY, JSON.stringify(next));
      } catch (error) {
        console.warn("Couldn't keep the pinned groups:", error);
      }
      setSaved(n => n + 1);
    };
    return {
      /** A page's pinned groups, in order. */
      of: (page: string): readonly string[] => pins()[page] ?? [],
      isPinned: (page: string, group: string) => (pins()[page] ?? []).includes(group),
      /** Pins a group after the ones pinned already, or unpins it. */
      set: (page: string, group: string, on: boolean) => {
        const current = read(options.storage)[page] ?? [];
        write(page, on ? [...current, group] : current.filter(other => other !== group));
      },
    };
  });
