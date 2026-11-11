// IPTV films and series matched to Cinemeta (PLAN.md, "Movies and Series by
// title", step 2), in the background while the modern layout is on: each
// title's cleaned name is searched for once, a few at a time, and the
// title with the same name and year gives its IMDb id and genres. The
// matches are kept in blocks of MATCH_BLOCK per source, each as JSON text,
// written every half a minute while matching goes on: only the blocks that
// changed, one at a time. A block is over 64 KB (the TV keeps the space of
// small deleted records, AGENTS.md), and as text IndexedDB copies it at
// once, where a big source's matches as objects took the TV close to a
// second (PLAN.md, "The long frames while matching"). New keys go in the
// last block, so as matching works through a source it writes one or two.
// A title with no match is tried again after a month.
//
// Two more ways, given by the library (src/data/moreMatches.ts): a title
// with a TMDB id from its list is found by that id first (`byTmdb`), and a
// title its name didn't find, or found only by a guessed name, is looked for
// again another way (`findMore`), as with TMDB's search, a few at a time
// after the names.

import { batch, createEffect, createMemo, createRoot, createSignal, untrack } from "solid-js";
import type { AddonMeta } from "../stremio/addon";
import { CLEANING, cleanTitle, nameKey, pickMatch } from "../stremio/cinemeta";
import { sortedCopy } from "./sortedCopy";

export type TitleType = "movie" | "series";

/** A title to match. */
export interface MatchItem {
  /** Its key in the VOD library, such as "<source>/m:<id>". */
  key: string;
  source: string;
  type: TitleType;
  name: string;
  year?: number;
  /** Its provider's category, whose tag may give its language. */
  category?: string;
  /** Its TMDB id, when the list gave it. */
  tmdb?: number;
  /** Whether its provider can give its TMDB id, as for an Xtream film. */
  askTmdb?: boolean;
}

/**
 * How a match was found: by the cleaned name, by a name guessed from it, by
 * the TMDB id (the list's or the provider's), by TMDB's search, or by TMDB's
 * search with the name spelled a little differently.
 */
export type MatchedBy = "name" | "guess" | "tmdb" | "tmdbSearch" | "tmdbClose";

export interface TitleMatch {
  /** The IMDb id, such as "tt0000001". */
  id: string;
  name: string;
  year?: number;
  poster?: string;
  genres: string[];
  /** Out of 10: IMDb's, from Cinemeta, or TMDB's when it was found there. */
  rating?: number;
  via?: MatchedBy;
  /** When a match by TMDB was found: it's looked for again after KEEP_TMDB_MS, as TMDB's terms ask. */
  at?: number;
  /**
   * Found by Cinemeta's search, which gives no genres or rating: its
   * details are asked for once the searches are done, so titles are joined
   * sooner.
   */
  partial?: true;
}

/** The keys whose matches were recorded, in turn, since the log with this id began. */
export interface MatchChanges {
  id: number;
  keys: readonly string[];
}

/** A match, or when the title was looked for and none was found. */
export type KeptMatch = TitleMatch | number;

/**
 * A block of a source's matches, or all of them in one record, as kept
 * before version 8 of the database.
 */
export interface MatchRecord {
  source: string;
  /** The block's number among the source's, from 0; none in a record from before. */
  block?: number;
  /** The Cinemeta address the matches came from; another's are looked for again. */
  cinemeta: string;
  /** The names' cleaning (CLEANING) when it was saved; titles not found with an older one are looked for again. */
  cleaning?: number;
  /** By key: as JSON text in a block, a record's own object from before. */
  matches: string | Record<string, KeptMatch>;
}

export interface MatchStore {
  load: () => Promise<MatchRecord[]>;
  /** Writes a block. */
  save: (record: MatchRecord) => Promise<void>;
  /** Deletes a source's blocks from `from` on, and its record from before. */
  trim: (source: string, from: number) => Promise<void>;
}

/** Matches in a block: about 0.4 MB, and still over 64 KB when none were found. */
export const MATCH_BLOCK = 2000;

/** Only what this file wrote, so the values aren't each checked. */
const isMatches = (value: unknown): value is Record<string, KeptMatch> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A record's matches, by key. */
export const matchesOf = (record: Pick<MatchRecord, "matches">): Record<string, KeptMatch> => {
  if (typeof record.matches !== "string") return record.matches;
  const parsed: unknown = JSON.parse(record.matches);
  return isMatches(parsed) ? parsed : {};
};

/** Lets the page draw between blocks, as a big source's take a while to read. */
const breathe = () => new Promise(resolve => setTimeout(resolve, 0));

export interface TitleMatcherOptions {
  items: () => MatchItem[];
  /** Matching runs only while this is true. */
  on: () => boolean;
  cinemetaUrl: () => string;
  /** Cinemeta's search for a cleaned title. */
  search: (type: TitleType, title: string) => Promise<AddonMeta[]>;
  /** Cinemeta's details, for a result that came without genres. */
  details?: (type: TitleType, id: string) => Promise<AddonMeta | undefined>;
  /** The title with this TMDB id. Many are asked for at once, when matching starts. */
  byTmdb?: (type: TitleType, tmdb: number) => Promise<TitleMatch | undefined>;
  /**
   * Another way to find a title its name didn't (or found only by a guess,
   * `byName`): the match, undefined when there's none, or null when it
   * couldn't be asked, so it's looked for again next time. `wanted` turns
   * false when the answer won't be used, as when matching is turned off.
   */
  findMore?: (
    item: MatchItem,
    byName: TitleMatch | undefined,
    wanted: () => boolean,
  ) => Promise<TitleMatch | undefined | null>;
  /** Titles looked for with `findMore` at once. */
  findMoreAtOnce?: number;
  store: MatchStore;
  now?: () => number;
  /** Titles looked for at once. */
  concurrency?: number;
  saveEveryMs?: number;
  /** How often the matches found are shown, so the pages aren't redrawn for each. */
  publishEveryMs?: number;
  /** Matches in a block; MATCH_BLOCK. */
  blockSize?: number;
}

export const RETRY_UNMATCHED_MS = 30 * 24 * 3_600_000;
/** How long a match by TMDB is kept: TMDB's terms allow six months at most. */
export const KEEP_TMDB_MS = 180 * 24 * 3_600_000;
const byTmdbWay = (match: TitleMatch) =>
  match.via === "tmdb" || match.via === "tmdbSearch" || match.via === "tmdbClose";

/**
 * Whether a match by TMDB id is the title: a provider's id is sometimes
 * another's ("Notebook 2019" had "The Notebook", 2004). The years must be
 * no more than one apart, when both are known, unless the names are the
 * same; names alone aren't compared, as they're often in other languages.
 */
export const agrees = (item: Pick<MatchItem, "name" | "year">, match: Pick<TitleMatch, "name" | "year">) => {
  const clean = cleanTitle(item.name, item.year);
  if (clean.year === undefined || match.year === undefined) return true;
  return Math.abs(clean.year - match.year) <= 1 || nameKey(clean.title) === nameKey(match.name);
};
/** How long to wait when Cinemeta can't be reached. */
const PAUSE_MS = 60_000;
/** How many times less often matches show once only `findMore` is left, which goes on for long. */
const MORE_PUBLISH = 15;

/** Each source's titles in turn, so a big source doesn't keep the rest waiting. */
const takeTurns = (items: MatchItem[]) => {
  const bySource = new Map<string, MatchItem[]>();
  for (const item of items) {
    let list = bySource.get(item.source);
    if (!list) bySource.set(item.source, (list = []));
    list.push(item);
  }
  const lists = [...bySource.values()];
  const out: MatchItem[] = [];
  for (let at = 0; out.length < items.length; at++)
    for (const list of lists) if (at < list.length) out.push(list[at]);
  return out;
};

export const createTitleMatcher = (options: TitleMatcherOptions) =>
  createRoot(() => {
    const now = options.now ?? (() => Date.now());
    const concurrency = options.concurrency ?? 4;
    // A big source's record is megabytes, so not too often.
    const saveEveryMs = options.saveEveryMs ?? 30_000;
    const publishEveryMs = options.publishEveryMs ?? 1500;
    const blockSize = options.blockSize ?? MATCH_BLOCK;

    /** By source, then by key. */
    const kept = new Map<string, Map<string, KeptMatch>>();
    /** Each source's blocks: the keys in each, in order, and the block of each key. */
    const blocks = new Map<string, { keys: string[][]; of: Map<string, number> }>();
    /**
     * Sources whose blocks are all written at the next save, then any after
     * them deleted, and the record from before: one read from that record,
     * or with blocks of another Cinemeta's.
     */
    const rewrite = new Set<string>();
    let keptFrom = "";
    const [ready, setReady] = createSignal(false);
    const [version, setVersion] = createSignal(0);
    /**
     * The keys whose match was recorded, in turn, so the titles can be
     * joined again for those only (src/data/titles.ts). A new log, with
     * another id, when every match may have changed.
     */
    let changeLog: string[] = [];
    let logId = 0;
    const [progress, setProgress] = createSignal({
      done: 0,
      total: 0,
      running: false,
      /** Titles waiting to be looked for another way (findMore). */
      waitingMore: 0,
      /** Titles looked for another way, since matching was turned on. */
      askedMore: 0,
      /** Matches waiting for their details (`partial`), by Cinemeta id. */
      waitingDetails: 0,
    });

    const sourceMap = (source: string) => {
      let map = kept.get(source);
      if (!map) kept.set(source, (map = new Map()));
      return map;
    };
    const blocksOf = (source: string) => {
      let one = blocks.get(source);
      if (!one) blocks.set(source, (one = { keys: [], of: new Map() }));
      return one;
    };
    /** The block a key is kept in; a new key goes in the last, or a new one when that's full. */
    const blockFor = (source: string, key: string) => {
      const one = blocksOf(source);
      let at = one.of.get(key);
      if (at === undefined) {
        at = one.keys.length - 1;
        if (at < 0 || one.keys[at].length >= blockSize) one.keys[++at] = [];
        one.keys[at].push(key);
        one.of.set(key, at);
      }
      return at;
    };

    // One search per cleaned name and year, however many sources have it.
    const asked = new Map<string, Promise<TitleMatch | undefined>>();
    /** Keys saved with an older cleaning, whose matches are checked again. */
    const recheck = new Set<string>();
    /** Titles looked for since the app started. */
    const fresh = new Set<string>();
    /** Cinemeta's details for partial matches, by type and id, as asked for. */
    const detailed = new Map<string, AddonMeta>();
    /** Partial matches waiting for their details, by type and id, with the titles that have them. */
    const waitingDetails = new Map<string, { type: TitleType; id: string; items: MatchItem[] }>();
    /** Those being asked for: a title found with one meanwhile joins it. */
    const askingDetails = new Map<string, { type: TitleType; id: string; items: MatchItem[] }>();
    const detailsKey = (type: TitleType, id: string) => `${type}/${id}`;

    // What's kept, once, and again if Cinemeta's address changes.
    let loads = 0;
    const loadKept = async (url: string) => {
      const mine = ++loads;
      // What's waiting is saved as the old address's, and its searches aren't used for the new one.
      clearTimeout(saveTimer);
      await flush();
      if (mine !== loads) return;
      asked.clear();
      detailed.clear();
      recheck.clear();
      fresh.clear();
      keptFrom = url;
      kept.clear();
      blocks.clear();
      rewrite.clear();
      changeLog = [];
      logId++;
      try {
        const records = await options.store.load();
        if (mine !== loads) return;
        // A source's record from before has all it had: blocks beside it are from writing it again, cut short.
        const before = new Set<string>();
        for (const record of records)
          if (record.block === undefined && record.cinemeta === url) before.add(record.source);
        const ordered = sortedCopy(records, (a, b) => (a.block ?? -1) - (b.block ?? -1));
        for (const record of ordered) {
          const { source, block } = record;
          if (record.cinemeta !== url) {
            // Another Cinemeta's blocks are written over, the next time this one's are written.
            if (block !== undefined) rewrite.add(source);
            continue;
          }
          if (block !== undefined && before.has(source)) continue;
          if (block === undefined) rewrite.add(source);
          const current = (record.cleaning ?? 1) >= CLEANING;
          const map = sourceMap(source);
          const one = blocksOf(source);
          const matches = matchesOf(record);
          const keys = Object.keys(matches);
          if (block !== undefined) one.keys[block] = keys;
          for (const key of keys) {
            const value = matches[key];
            // Unmatched with an older cleaning: looked for again.
            if (current || typeof value === "object") map.set(key, value);
            if (!current) recheck.add(key);
            if (block === undefined) blockFor(source, key);
            else one.of.set(key, block);
          }
          await breathe();
          if (mine !== loads) return;
        }
        for (const [source, one] of blocks) {
          // Blocks missing between others, which shouldn't be: all are written again, from the first.
          let whole = true;
          for (let i = 0; i < one.keys.length; i++) if (!one.keys[i]) whole = false;
          if (!whole) {
            const keys: string[] = [];
            for (const list of one.keys) if (list) keys.push(...list);
            blocks.delete(source);
            for (const key of keys) blockFor(source, key);
            rewrite.add(source);
          }
        }
        // Those from before are written as blocks soon, so the next start reads them fast.
        for (const source of rewrite) if (kept.get(source)?.size) markDirty(source, 0);
      } catch (error) {
        console.warn("Couldn't read the titles matched before:", error);
      }
      // Every match may be another now, including for titles joined while reading.
      changeLog = [];
      logId++;
      batch(() => {
        setReady(true);
        setVersion(n => n + 1);
      });
    };

    // Saving and showing, a while after the last change.
    /** The blocks changed, by source. */
    const dirty = new Map<string, Set<number>>();
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    const markDirty = (source: string, block: number) => {
      let numbers = dirty.get(source);
      if (!numbers) dirty.set(source, (numbers = new Set()));
      numbers.add(block);
      saveTimer ??= setTimeout(() => void flush(), saveEveryMs);
    };
    /** Writes the blocks changed, each in its own task, so the page draws between them. */
    const flush = async () => {
      saveTimer = undefined;
      const waiting = [...dirty];
      dirty.clear();
      for (const [source, numbers] of waiting) {
        const map = kept.get(source);
        const one = blocks.get(source);
        if (!map || !one) continue;
        const all = rewrite.delete(source);
        let failed = false;
        for (let block = 0; block < one.keys.length; block++) {
          if (!all && !numbers.has(block)) continue;
          const matches: Record<string, KeptMatch> = {};
          for (const key of one.keys[block]) {
            const value = map.get(key);
            if (value !== undefined) matches[key] = value;
          }
          const record = {
            source,
            block,
            cinemeta: keptFrom,
            cleaning: CLEANING,
            matches: JSON.stringify(matches),
          };
          try {
            await options.store.save(record);
          } catch (error) {
            failed = true;
            console.warn("Couldn't keep the titles matched:", error);
          }
        }
        if (!all) continue;
        try {
          // What was there before goes only once all of it is written again.
          if (failed) throw new Error("A block wasn't written");
          await options.store.trim(source, one.keys.length);
        } catch (error) {
          rewrite.add(source);
          console.warn("Couldn't clear the titles matched before:", error);
        }
      }
    };
    /**
     * Joining a big library's titles again takes a while (src/data/titles.ts),
     * so its matches show less often; and once only `findMore` is left, which
     * goes on for long, finding a few, seldom.
     */
    const publishDelay = () =>
      Math.max(publishEveryMs, queue.length, next >= queue.length ? publishEveryMs * MORE_PUBLISH : 0);
    const changed = (source: string, key: string, found: boolean) => {
      markDirty(source, blockFor(source, key));
      // A title with no match changes nothing shown.
      if (!found) return;
      publishTimer ??= setTimeout(() => {
        publishTimer = undefined;
        setVersion(n => n + 1);
      }, publishDelay());
    };

    const lookUp = (item: MatchItem) => {
      const { title, year, others } = cleanTitle(item.name, item.year);
      const id = `${item.type}/${nameKey(title)}/${year ?? ""}`;
      let found = asked.get(id);
      if (!found) {
        found = (async () => {
          let meta = pickMatch(await options.search(item.type, title), title, year);
          let via: MatchedBy = "name";
          // Names the provider may have written its own way, one at a time until one is found.
          for (const other of others) {
            if (meta) break;
            // A guessed name (with a year) needs the result's year too; the whole name is searched alone.
            const strict = other.year !== undefined;
            meta = pickMatch(await options.search(item.type, other.title), other.title, other.year, strict);
            if (strict) via = "guess";
          }
          if (!meta) return undefined;
          const match: TitleMatch = { id: meta.id, name: meta.name, genres: meta.genres ?? [], via };
          if (meta.year) match.year = meta.year;
          if (meta.poster) match.poster = meta.poster;
          if (meta.rating) match.rating = meta.rating;
          // Cinemeta's search gives no genres: its details come after every search (askDetails).
          if (!meta.genres?.length && options.details) match.partial = true;
          return match;
        })();
        asked.set(id, found);
        found.catch(() => asked.delete(id));
      }
      return found;
    };

    /** The title with a TMDB id from its list, asked for once. */
    const byTmdb = (type: TitleType, tmdb: number) => {
      const id = `tmdb/${type}/${tmdb}`;
      let found = asked.get(id);
      if (!found) {
        if (!options.byTmdb) return Promise.resolve(undefined);
        found = options.byTmdb(type, tmdb);
        asked.set(id, found);
        found.catch(() => asked.delete(id));
      }
      return found;
    };
    /** By TMDB id, or null when that fails, so the name is tried. */
    const byTmdbOrNot = (type: TitleType, tmdb: number) =>
      byTmdb(type, tmdb).catch((error: unknown) => {
        console.warn("Couldn't match a title by its TMDB id:", error);
        return null;
      });

    /** A partial match with its details. The name stays the search's, which was compared. */
    const withDetails = (match: TitleMatch, full: AddonMeta): TitleMatch => {
      const out: TitleMatch = { ...match, genres: full.genres ?? match.genres };
      delete out.partial;
      if (full.year) out.year = full.year;
      if (full.poster) out.poster = full.poster;
      if (full.rating) out.rating = full.rating;
      return out;
    };
    const waitForDetails = (item: MatchItem, match: TitleMatch) => {
      const key = detailsKey(item.type, match.id);
      let one = askingDetails.get(key) ?? waitingDetails.get(key);
      if (!one) waitingDetails.set(key, (one = { type: item.type, id: match.id, items: [] }));
      if (!one.items.some(other => other.key === item.key)) one.items.push(item);
    };
    const detailsCount = () => setProgress(p => ({ ...p, waitingDetails: waitingDetails.size }));

    const record = (item: MatchItem, given: TitleMatch | undefined) => {
      let match = given;
      if (match?.partial) {
        const full = detailed.get(detailsKey(item.type, match.id));
        if (full) match = withDetails(match, full);
        else {
          waitForDetails(item, match);
          detailsCount();
          start();
        }
      }
      sourceMap(item.source).set(
        item.key,
        match && byTmdbWay(match) ? { ...match, at: now() } : (match ?? now()),
      );
      fresh.add(item.key);
      changeLog.push(item.key);
      changed(item.source, item.key, match !== undefined);
    };

    /**
     * Titles to look for another way (findMore), a few at a time, with what
     * their name found. Not kept: one left when the app closes is looked
     * for again. They stay in a new round, as this is slow; only turning
     * matching off, or another Cinemeta, ends them (epoch++).
     */
    let later: { item: MatchItem; byName: TitleMatch | undefined }[] = [];
    /** Those waiting or being looked for. */
    const laterKeys = new Set<string>();
    let epoch = 0;
    /** findMore's loops running in this epoch. */
    let laterLoops = 0;
    const laterCount = () => setProgress(p => ({ ...p, waitingMore: laterKeys.size }));
    const needsMore = (match: TitleMatch | undefined) =>
      options.findMore !== undefined && (match === undefined || match.via === "guess");
    const askLater = async (mine: number) => {
      const findMore = options.findMore;
      if (!findMore) return;
      laterLoops++;
      try {
        const going = () => mine === epoch && later.length > 0;
        while (going()) {
          const one = later.shift();
          if (!one) break;
          let found: TitleMatch | undefined | null;
          try {
            found = await findMore(one.item, one.byName, () => mine === epoch);
          } catch (error) {
            console.warn("Couldn't look for a title another way:", error);
            found = null;
          }
          if (mine !== epoch) return;
          laterKeys.delete(one.item.key);
          // Without an answer, it's looked for again next time.
          if (found !== null) record(one.item, found ?? one.byName);
          setProgress(p => ({ ...p, askedMore: p.askedMore + 1 }));
          laterCount();
        }
      } finally {
        if (mine === epoch) {
          laterLoops--;
          settle();
        }
      }
    };
    const startLater = () => {
      const wanted = Math.min(options.findMoreAtOnce ?? 1, later.length);
      for (let i = laterLoops; i < wanted; i++) void askLater(epoch);
    };
    const askMore = (item: MatchItem, byName: TitleMatch | undefined) => {
      if (laterKeys.has(item.key)) return;
      laterKeys.add(item.key);
      later.push({ item, byName });
      laterCount();
      startLater();
    };
    /** Matching is off, or Cinemeta another: what's waiting for findMore is forgotten. */
    const endEpoch = () => {
      epoch++;
      later = [];
      laterKeys.clear();
      laterLoops = 0;
      // Asked for again from what's kept, at the next round.
      waitingDetails.clear();
      askingDetails.clear();
      setProgress(p => ({ ...p, waitingMore: 0, askedMore: 0, waitingDetails: 0 }));
    };

    const isDue = (item: MatchItem) => {
      const value = kept.get(item.source)?.get(item.key);
      if (value === undefined) return true;
      if (typeof value === "object" && byTmdbWay(value)) {
        // One kept from before matches had a time: from now, then.
        value.at ??= now();
        if (now() - value.at > KEEP_TMDB_MS) return true;
        // By a TMDB id that turns out to be another title's, before that was checked.
        if (value.via === "tmdb" && !fresh.has(item.key) && !agrees(item, value)) return true;
      }
      // Found by an older cleaning under another name: it may have been a wrong guess. A TMDB match is sure.
      if (typeof value === "object" && recheck.has(item.key) && !fresh.has(item.key))
        return !byTmdbWay(value) && nameKey(value.name) !== nameKey(cleanTitle(item.name, item.year).title);
      return typeof value === "number" && now() - value > RETRY_UNMATCHED_MS;
    };

    let queue: MatchItem[] = [];
    let next = 0;
    let workers = 0;
    let pausedUntil = 0;
    let round = 0;
    /**
     * The details of a partial match, for each title that has it still;
     * without them (Cinemeta couldn't be reached, or had none), it stays
     * partial, and they're asked for again next time.
     */
    const askDetails = async (one: { type: TitleType; id: string; items: MatchItem[] }) => {
      const key = detailsKey(one.type, one.id);
      askingDetails.set(key, one);
      let full: AddonMeta | undefined;
      try {
        full = await options.details?.(one.type, one.id);
      } finally {
        if (askingDetails.get(key) === one) askingDetails.delete(key);
      }
      if (!full) return;
      detailed.set(key, full);
      for (const item of one.items) {
        const value = kept.get(item.source)?.get(item.key);
        if (typeof value === "object" && value.partial && value.id === one.id) record(item, value);
      }
    };
    /** The next partial match to ask details for, in the order they were found. */
    const nextDetails = () => {
      const first = waitingDetails.keys().next();
      if (first.done) return undefined;
      const one = waitingDetails.get(first.value);
      waitingDetails.delete(first.value);
      detailsCount();
      return one;
    };

    const work = async (mine: number) => {
      workers++;
      try {
        // A new round (round++) or a pause ends this worker.
        const going = () => mine === round && now() >= pausedUntil;
        while (going()) {
          if (next >= queue.length) {
            // Every search is done or going: the details of what they found.
            const one = nextDetails();
            if (!one) break;
            try {
              await askDetails(one);
            } catch (error) {
              console.warn("Couldn't ask Cinemeta for a title's details:", error);
            }
            continue;
          }
          const item = queue[next++];
          if (!isDue(item)) continue;
          try {
            let match: TitleMatch | undefined | null =
              item.tmdb === undefined ? undefined : await byTmdbOrNot(item.type, item.tmdb);
            const tmdbFailed = match === null;
            if (match && !agrees(item, match)) match = undefined;
            match = match ?? (await lookUp(item));
            if (mine !== round) break;
            if (needsMore(match)) askMore(item, match);
            else if (match || !tmdbFailed) record(item, match);
          } catch (error) {
            // Cinemeta is down, or the network: wait, then go on from here.
            console.warn("Couldn't match a title with Cinemeta:", error);
            next--;
            pausedUntil = now() + PAUSE_MS;
            setTimeout(() => untrack(start), PAUSE_MS);
            break;
          }
          setProgress(p => ({ ...p, done: Math.min(p.total, next) }));
        }
      } finally {
        // Workers of a round before were forgotten when it began.
        if (mine === round) {
          workers--;
          settle();
        }
      }
    };
    /** Once nothing is left to do: the last matches at once. */
    const settle = () => {
      if (workers > 0 || laterKeys.size > 0 || laterLoops > 0 || waitingDetails.size > 0) return;
      setProgress(p => ({ ...p, running: false }));
      if (publishTimer !== undefined) {
        clearTimeout(publishTimer);
        publishTimer = undefined;
        setVersion(n => n + 1);
      }
    };
    const start = () => {
      if (now() < pausedUntil) return;
      const wanted = Math.min(concurrency, Math.max(0, queue.length - next) + waitingDetails.size);
      if (wanted > 0) setProgress(p => ({ ...p, running: true }));
      for (let i = workers; i < wanted; i++) void work(round);
    };

    // Only when it turns on or off, not each time what it reads changes.
    const isOn = createMemo(() => options.on());
    createEffect(() => {
      const url = options.cinemetaUrl();
      const on = isOn();
      // Read first, so the effect runs again once what's kept is read.
      const isReady = ready();
      if (!on) {
        round++;
        endEpoch();
        return;
      }
      if (url !== keptFrom) {
        round++;
        endEpoch();
        setReady(false);
        void loadKept(url);
        return;
      }
      if (!isReady) return;
      const items = options.items();
      untrack(() => {
        round++;
        const due = items.filter(isDue);
        // Those with a TMDB id first: they're found surely, and quickly.
        queue = takeTurns([
          ...due.filter(one => one.tmdb !== undefined),
          ...due.filter(one => one.tmdb === undefined),
        ]);
        next = 0;
        // Asked for all at once, so they can go in one query (as to Wikidata).
        for (const one of queue) if (one.tmdb !== undefined) void byTmdbOrNot(one.type, one.tmdb);
        // Partial matches kept, as when the app closed before their details came: after the searches.
        waitingDetails.clear();
        for (const one of items) {
          const value = kept.get(one.source)?.get(one.key);
          if (typeof value !== "object" || !value.partial || isDue(one)) continue;
          if (detailed.has(detailsKey(one.type, value.id))) record(one, value);
          else waitForDetails(one, value);
        }
        detailsCount();
        setProgress(p => ({ ...p, done: 0, total: queue.length, running: laterKeys.size > 0 }));
        // The workers of the round before stop after the title they're on.
        workers = 0;
        start();
        startLater();
      });
    });

    return {
      /**
       * The match for a title, or undefined when it has none (yet). Not
       * tracked: read version() once, before asking for many.
       */
      matchOf: (item: Pick<MatchItem, "key" | "source">) => {
        const value = kept.get(item.source)?.get(item.key);
        return typeof value === "object" ? value : undefined;
      },
      /** Goes up as matches are shown. */
      version,
      /** The keys recorded since the log began; read after version(). */
      changes: (): MatchChanges => ({ id: logId, keys: changeLog }),
      /** How far this round's matching has got: titles looked at, of those due. */
      progress,
      /** Saves what's waiting to be saved, as before the app closes. */
      flush,
      /**
       * For probes (scripts/tv-probe/probes/match-frames.js): records `count`
       * of the matches kept again, as copies, spread over every source, and
       * shows them at once, as matching does, without changing what's kept.
       * Their blocks are written at the next save, or flush(). Returns how many.
       */
      reshow: (count: number) => {
        const all: [string, string, TitleMatch][] = [];
        for (const [source, map] of kept)
          for (const [key, value] of map) if (typeof value === "object") all.push([source, key, value]);
        const step = Math.max(1, Math.floor(all.length / Math.max(1, count)));
        let done = 0;
        for (let i = 0; i < all.length && done < count; i += step, done++) {
          const [source, key, value] = all[i];
          sourceMap(source).set(key, { ...value });
          changeLog.push(key);
          markDirty(source, blockFor(source, key));
        }
        setVersion(n => n + 1);
        return done;
      },
    };
  });

export type TitleMatcher = ReturnType<typeof createTitleMatcher>;
