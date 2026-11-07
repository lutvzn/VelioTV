// The user's edits to channels, kept in localStorage like the sources, so
// they're there as soon as the app starts and the backup (PLAN.md, Phase 5,
// step 7) can take them. Channels are named by id, which stays the same when
// their source imports again (src/data/channelKey.ts); edits to a channel the
// source no longer has are kept, in case it comes back.
//
// Phase 5, step 1 holds favourites only; later steps add hidden, locked and
// moved channels.

import { createMemo, createRoot, createSignal } from "solid-js";

const STORAGE_KEY = "tiviplayer.channelEdits";
const STORAGE_VERSION = 1;

export interface ChannelEdits {
  /** Favourite channel ids, in the order added. */
  favourites: string[];
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === "string");

const load = (storage: Storage): ChannelEdits => {
  try {
    const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object" && "favourites" in saved && isStringArray(saved.favourites)) {
      return { favourites: saved.favourites };
    }
  } catch (error) {
    console.error("Couldn't read the channel edits:", error);
  }
  return { favourites: [] };
};

export const createChannelEdits = (options: { storage: Storage }) =>
  createRoot(() => {
    const [edits, setEdits] = createSignal(load(options.storage));
    const favouriteIds = createMemo(() => new Set(edits().favourites));

    const save = (next: ChannelEdits) => {
      setEdits(next);
      try {
        options.storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...next }));
      } catch (error) {
        console.error("Couldn't save the channel edits:", error);
      }
    };

    const setFavourite = (id: string, favourite: boolean) => {
      if (favouriteIds().has(id) === favourite) return;
      const { favourites } = edits();
      save({
        ...edits(),
        favourites: favourite ? [...favourites, id] : favourites.filter(other => other !== id),
      });
    };

    return {
      /** Favourite channel ids, in the order added. */
      favourites: () => edits().favourites,
      isFavourite: (id: string) => favouriteIds().has(id),
      setFavourite,
      toggleFavourite: (id: string) => setFavourite(id, !favouriteIds().has(id)),
    };
  });

export type ChannelEditStore = ReturnType<typeof createChannelEdits>;
