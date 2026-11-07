// The user's edits to channels and groups, kept in localStorage like the
// sources, so they're there as soon as the app starts and the backup
// (PLAN.md, Phase 5, step 7) can take them. Channels are named by id, which
// stays the same when their source imports again (src/data/channelKey.ts);
// edits to a channel the source no longer has are kept, in case it comes
// back, until the source itself is removed.
//
// Groups are named by key: a playlist group's name (as the playlist has it,
// "" for channels without one), or a custom group's key, made here. What the
// edits do to the lineup is worked out in src/live/liveView.ts.

import { createMemo, createRoot, createSignal } from "solid-js";

const STORAGE_KEY = "tiviplayer.channelEdits";
const STORAGE_VERSION = 1;

/** How a group's channels are ordered: as the playlist has them, by number, or by name. */
export type GroupSort = "playlist" | "number" | "name";
export const GROUP_SORTS: readonly GroupSort[] = ["playlist", "number", "name"];

/** Custom group keys start with this, which playlist group names never do. */
export const CUSTOM_GROUP = "\u0001";

export interface ChannelEdits {
  /** Favourite channel ids, in the user's order. */
  favourites: string[];
  hiddenChannels: string[];
  hiddenGroups: string[];
  lockedChannels: string[];
  lockedGroups: string[];
  /** Group key to the name shown: a playlist group renamed, or a custom group's name. */
  groupNames: Record<string, string>;
  /** Custom group keys, in the order made. */
  customGroups: string[];
  /** Group keys in the user's order; groups not listed follow, in playlist order. */
  groupOrder: string[];
  /** Channel id to the key of the group it was moved to. */
  movedChannels: Record<string, string>;
  /** Group key to its order, where it isn't the playlist's. */
  groupSort: Record<string, GroupSort>;
}

export const emptyEdits = (): ChannelEdits => ({
  favourites: [],
  hiddenChannels: [],
  hiddenGroups: [],
  lockedChannels: [],
  lockedGroups: [],
  groupNames: {},
  customGroups: [],
  groupOrder: [],
  movedChannels: {},
  groupSort: {},
});

const LISTS = [
  "favourites",
  "hiddenChannels",
  "hiddenGroups",
  "lockedChannels",
  "lockedGroups",
  "customGroups",
  "groupOrder",
] as const;
type ListName = (typeof LISTS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown) =>
  Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
const stringMap = <T extends string>(value: unknown, test: (item: unknown) => item is T) => {
  const out: Record<string, T> = {};
  if (isRecord(value)) for (const [key, item] of Object.entries(value)) if (test(item)) out[key] = item;
  return out;
};
const isString = (item: unknown): item is string => typeof item === "string";
const isSort = (item: unknown): item is GroupSort => GROUP_SORTS.some(sort => sort === item);

/** Reads saved or restored edits, leaving out what doesn't fit. */
export const readEdits = (value: unknown): ChannelEdits => {
  const edits = emptyEdits();
  if (!isRecord(value)) return edits;
  for (const list of LISTS) edits[list] = strings(value[list]);
  edits.groupNames = stringMap(value.groupNames, isString);
  edits.movedChannels = stringMap(value.movedChannels, isString);
  edits.groupSort = stringMap(value.groupSort, isSort);
  return edits;
};

const load = (storage: Storage): ChannelEdits => {
  try {
    return readEdits(JSON.parse(storage.getItem(STORAGE_KEY) ?? "null"));
  } catch (error) {
    console.error("Couldn't read the channel edits:", error);
    return emptyEdits();
  }
};

const without = <T>(record: Record<string, T>, drop: (key: string, value: T) => boolean) =>
  Object.fromEntries(Object.entries(record).filter(([key, value]) => !drop(key, value)));

export const createChannelEdits = (options: { storage: Storage; newKey?: () => string }) =>
  createRoot(() => {
    const [edits, setEdits] = createSignal(load(options.storage));
    // Each list as a set, for looking ids up; made again only when it changes.
    const sets = new Map(LISTS.map(list => [list, createMemo(() => new Set(edits()[list]))]));
    const inList = (list: ListName, id: string) => sets.get(list)?.().has(id) ?? false;
    const newKey =
      options.newKey ??
      (() => `${CUSTOM_GROUP}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);

    const save = (next: ChannelEdits) => {
      setEdits(next);
      try {
        options.storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...next }));
      } catch (error) {
        console.error("Couldn't save the channel edits:", error);
      }
    };
    const update = (change: (current: ChannelEdits) => Partial<ChannelEdits>) =>
      save({ ...edits(), ...change(edits()) });

    /** Adds `id` to the end of a list, or takes it out. */
    const setIn = (list: ListName, id: string, on: boolean) => {
      if (inList(list, id) === on) return;
      update(current => ({
        [list]: on ? [...current[list], id] : current[list].filter(other => other !== id),
      }));
    };
    const has = (list: ListName) => (id: string) => inList(list, id);

    /** Moves `id` to `index` in a list. */
    const moveIn = (list: "favourites" | "groupOrder", id: string, index: number) => {
      const items = edits()[list];
      const from = items.indexOf(id);
      const to = Math.max(0, Math.min(items.length - 1, index));
      if (from < 0 || from === to) return;
      const next = items.filter(other => other !== id);
      next.splice(to, 0, id);
      update(() => ({ [list]: next }));
    };

    return {
      /** Everything, as stored and backed up. */
      all: edits,
      /** Replaces everything, as a restore does. */
      replace: (next: ChannelEdits) => save(readEdits(next)),

      // Favourites.
      favourites: () => edits().favourites,
      isFavourite: has("favourites"),
      setFavourite: (id: string, on: boolean) => setIn("favourites", id, on),
      toggleFavourite: (id: string) => setIn("favourites", id, !inList("favourites", id)),
      moveFavourite: (id: string, index: number) => moveIn("favourites", id, index),

      // Hiding.
      isChannelHidden: has("hiddenChannels"),
      setChannelHidden: (id: string, on: boolean) => setIn("hiddenChannels", id, on),
      isGroupHidden: has("hiddenGroups"),
      setGroupHidden: (key: string, on: boolean) => setIn("hiddenGroups", key, on),

      // Locks.
      isChannelLocked: has("lockedChannels"),
      setChannelLocked: (id: string, on: boolean) => setIn("lockedChannels", id, on),
      isGroupLocked: has("lockedGroups"),
      setGroupLocked: (key: string, on: boolean) => setIn("lockedGroups", key, on),

      // Groups.
      groupNames: () => edits().groupNames,
      /** Renames a group; an empty name puts a playlist group's own back. */
      renameGroup: (key: string, name: string) => {
        const trimmed = name.trim();
        if (!trimmed && key.startsWith(CUSTOM_GROUP)) return;
        update(current => ({
          groupNames: trimmed
            ? { ...current.groupNames, [key]: trimmed }
            : without(current.groupNames, other => other === key),
        }));
      },
      customGroups: () => edits().customGroups,
      /** Makes an empty custom group, and returns its key. */
      createGroup: (name: string) => {
        const key = newKey();
        update(current => ({
          customGroups: [...current.customGroups, key],
          groupNames: { ...current.groupNames, [key]: name.trim() || "?" },
        }));
        return key;
      },
      /** Removes a custom group; its channels go back to their own groups. */
      deleteGroup: (key: string) =>
        update(current => ({
          customGroups: current.customGroups.filter(other => other !== key),
          groupNames: without(current.groupNames, other => other === key),
          groupOrder: current.groupOrder.filter(other => other !== key),
          hiddenGroups: current.hiddenGroups.filter(other => other !== key),
          lockedGroups: current.lockedGroups.filter(other => other !== key),
          groupSort: without(current.groupSort, other => other === key),
          movedChannels: without(current.movedChannels, (_id, target) => target === key),
        })),
      movedTo: (id: string): string | undefined => edits().movedChannels[id],
      /** Moves a channel into a group; undefined puts it back in its own. */
      moveChannel: (id: string, key: string | undefined) =>
        update(current => ({
          movedChannels:
            key === undefined
              ? without(current.movedChannels, other => other === id)
              : { ...current.movedChannels, [id]: key },
        })),
      groupOrder: () => edits().groupOrder,
      /** Sets the order of groups; the view passes every group shown. */
      setGroupOrder: (keys: string[]) => update(() => ({ groupOrder: [...new Set(keys)] })),
      sortOf: (key: string): GroupSort => edits().groupSort[key] ?? "playlist",
      setGroupSort: (key: string, sort: GroupSort) =>
        update(current => ({
          groupSort:
            sort === "playlist"
              ? without(current.groupSort, other => other === key)
              : { ...current.groupSort, [key]: sort },
        })),

      /** Forgets every edit to a removed source's channels. */
      forgetSource: (source: string) => {
        const prefix = `${source}/`;
        const keep = (id: string) => !id.startsWith(prefix);
        update(current => ({
          favourites: current.favourites.filter(keep),
          hiddenChannels: current.hiddenChannels.filter(keep),
          lockedChannels: current.lockedChannels.filter(keep),
          movedChannels: without(current.movedChannels, id => !keep(id)),
        }));
      },
    };
  });

export type ChannelEditStore = ReturnType<typeof createChannelEdits>;
