// Where each film and episode was left (PLAN.md, Phase 6, step 5), kept in
// localStorage like the edits, so Continue watching shows at once and a
// backup can hold it. Only the newest entries are kept.
//
// A film or episode watched nearly to the end counts as finished: it leaves
// Continue watching, and a series then offers its next episode.

import { createSignal } from "solid-js";

const STORAGE_KEY = "velio.watched";
const VERSION = 1;
/** Entries kept, newest first. */
export const MAX_WATCHED = 300;
/** Played this far, it counts as finished. */
export const FINISHED_AT = 0.95;
/** Less than this in, it isn't worth resuming. */
export const RESUME_AFTER_MS = 30_000;

/** A film or an episode, as the resume list knows it. */
export interface WatchedItem {
  /** "<source>/m:<id>" for a film, "<source>/e:<id>" for an episode. */
  key: string;
  kind: "film" | "episode";
  title: string;
  poster?: string;
  /** An episode's series, as "<source>/s:<id>", and its name. */
  series?: string;
  seriesName?: string;
  season?: number;
  episode?: number;
}

export interface WatchedEntry extends WatchedItem {
  positionMs: number;
  durationMs: number;
  updatedAt: number;
  finished: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Reads one entry, leaving out what doesn't fit. */
const readEntry = (value: unknown): WatchedEntry | undefined => {
  if (!isRecord(value)) return undefined;
  const key = text(value.key);
  const title = text(value.title);
  if (!key || !title || (value.kind !== "film" && value.kind !== "episode")) return undefined;
  const entry: WatchedEntry = {
    key,
    kind: value.kind,
    title,
    positionMs: count(value.positionMs),
    durationMs: count(value.durationMs),
    updatedAt: count(value.updatedAt),
    finished: value.finished === true,
  };
  for (const name of ["poster", "series", "seriesName"] as const) {
    const one = text(value[name]);
    if (one) entry[name] = one;
  }
  for (const name of ["season", "episode"] as const) {
    if (typeof value[name] === "number") entry[name] = value[name];
  }
  return entry;
};

/** Reads saved or restored entries, newest first, each key once. */
export const readWatched = (list: unknown): WatchedEntry[] => {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const entries = list.map(readEntry).filter((entry): entry is WatchedEntry => {
    if (!entry || seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
  return entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_WATCHED);
};

const load = (storage: Storage) => {
  try {
    const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    return isRecord(saved) ? readWatched(saved.entries) : [];
  } catch (error) {
    console.error("Couldn't read where films were left:", error);
    return [];
  }
};

export const createWatched = (options: { storage: Storage; now?: () => number }) => {
  const now = options.now ?? Date.now;
  const [entries, setEntries] = createSignal<WatchedEntry[]>(load(options.storage));
  const save = (list: WatchedEntry[]) => {
    const kept = list.slice(0, MAX_WATCHED);
    setEntries(kept);
    try {
      options.storage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, entries: kept }));
    } catch (error) {
      console.error("Couldn't save where films were left:", error);
    }
  };
  const find = (key: string) => entries().find(entry => entry.key === key);

  return {
    /** Newest first. */
    all: entries,
    get: find,

    /** Where to start an item again: its position, unless it's finished or barely begun. */
    resumeAt: (key: string) => {
      const entry = find(key);
      return entry && !entry.finished && entry.positionMs >= RESUME_AFTER_MS ? entry.positionMs : undefined;
    },

    /** Notes how far an item has played; near the end, it's finished. */
    progress: (item: WatchedItem, positionMs: number, durationMs: number) => {
      const finished = durationMs > 0 && positionMs >= durationMs * FINISHED_AT;
      const entry: WatchedEntry = {
        ...item,
        positionMs: finished ? 0 : Math.max(0, Math.round(positionMs)),
        durationMs: Math.max(0, Math.round(durationMs)),
        updatedAt: now(),
        finished,
      };
      save([entry, ...entries().filter(other => other.key !== item.key)]);
    },

    /** Marks an item played to its end. */
    finish: (item: WatchedItem) => {
      const before = find(item.key);
      const entry: WatchedEntry = {
        ...item,
        positionMs: 0,
        durationMs: before?.durationMs ?? 0,
        updatedAt: now(),
        finished: true,
      };
      save([entry, ...entries().filter(other => other.key !== item.key)]);
    },

    remove: (key: string) => save(entries().filter(entry => entry.key !== key)),

    /** Films part watched, newest first. */
    unfinishedFilms: () =>
      entries().filter(
        entry => entry.kind === "film" && !entry.finished && entry.positionMs >= RESUME_AFTER_MS,
      ),

    /** Each series' newest episode, newest first. */
    latestEpisodes: () => {
      const seen = new Set<string>();
      return entries().filter(entry => {
        if (entry.kind !== "episode" || !entry.series || seen.has(entry.series)) return false;
        seen.add(entry.series);
        return true;
      });
    },

    /** Puts a restored list in place of this one. */
    replace: (list: unknown) => save(readWatched(list)),
    /** Reads it again from storage, such as for another profile (src/data/profiles.ts). */
    reload: () => setEntries(load(options.storage)),

    /** Forgets a removed source's items. */
    forgetSource: (source: string) => save(entries().filter(entry => !entry.key.startsWith(`${source}/`))),
  };
};

export type Watched = ReturnType<typeof createWatched>;
