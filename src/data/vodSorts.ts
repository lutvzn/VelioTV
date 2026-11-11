// How each Movies and Series group is ordered (src/pages/vod/hubOrder.ts),
// chosen on the page by holding OK on the group, or with the Tools key. Each
// profile keeps its own (src/data/profiles.ts), by page and group.

import { createMemo, createRoot, createSignal } from "solid-js";

export type TitleSort = "added" | "name" | "year" | "rating" | "listed";
export const TITLE_SORTS: readonly TitleSort[] = ["added", "name", "year", "rating", "listed"];
export const isTitleSort = (value: unknown): value is TitleSort => TITLE_SORTS.some(sort => sort === value);

export const VOD_SORTS_KEY = "velio.vodSorts";

type Sorts = Record<string, Record<string, TitleSort>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const read = (storage: Storage): Sorts => {
  try {
    const value: unknown = JSON.parse(storage.getItem(VOD_SORTS_KEY) ?? "{}");
    if (!isRecord(value)) return {};
    const sorts: Sorts = {};
    for (const [page, groups] of Object.entries(value)) {
      if (!isRecord(groups)) continue;
      const kept: Record<string, TitleSort> = {};
      for (const [group, sort] of Object.entries(groups)) if (isTitleSort(sort)) kept[group] = sort;
      sorts[page] = kept;
    }
    return sorts;
  } catch {
    return {};
  }
};

export const createVodSorts = (options: { storage: Storage; profile: () => string | undefined }) =>
  createRoot(() => {
    const [saved, setSaved] = createSignal(0);
    const sorts = createMemo(() => {
      options.profile();
      saved();
      return read(options.storage);
    });
    return {
      /** The order chosen for a page's group, if one was. */
      sortOf: (page: string, group: string): TitleSort | undefined => sorts()[page]?.[group],
      set: (page: string, group: string, sort: TitleSort) => {
        const next = read(options.storage);
        next[page] = { ...next[page], [group]: sort };
        try {
          options.storage.setItem(VOD_SORTS_KEY, JSON.stringify(next));
        } catch (error) {
          console.warn("Couldn't keep the order:", error);
        }
        setSaved(n => n + 1);
      },
    };
  });
