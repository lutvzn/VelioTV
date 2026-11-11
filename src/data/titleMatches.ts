// IPTV films and series matched to Cinemeta (PLAN.md, "Movies and Series by
// title", step 2), in the background while the modern layout is on: each
// title's cleaned name is searched for once, a few at a time, and the
// title with the same name and year gives its IMDb id and genres. The
// matches are kept in a record per source, written every half a minute while
// matching goes on, so each record is either large or seldom written (the
// TV keeps the space of small deleted records, AGENTS.md). A title with no
// match is tried again after a month.
//
// Two more ways, given by the library (src/data/moreMatches.ts): a title
// with a TMDB id from its list is found by that id first (`byTmdb`), and a
// title its name didn't find, or found only by a guessed name, is looked for
// again another way (`findMore`), as with TMDB's search, a few at a time
// after the names.

import { batch, createEffect, createMemo, createRoot, createSignal, untrack } from "solid-js";
import type { AddonMeta } from "../stremio/addon";
import { CLEANING, cleanTitle, nameKey, pickMatch } from "../stremio/cinemeta";

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
}

/** The keys whose matches were recorded, in turn, since the log with this id began. */
export interface MatchChanges {
  id: number;
  keys: readonly string[];
}

/** A match, or when the title was looked for and none was found. */
export type KeptMatch = TitleMatch | number;

export interface MatchRecord {
  source: string;
  /** The Cinemeta address the matches came from; another's are looked for again. */
  cinemeta: string;
  /** The names' cleaning (CLEANING) when it was saved; titles not found with an older one are looked for again. */
  cleaning?: number;
  matches: Record<string, KeptMatch>;
}

export interface MatchStore {
  load: () => Promise<MatchRecord[]>;
  save: (record: MatchRecord) => Promise<void>;
}

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

    /** By source, then by key. */
    const kept = new Map<string, Map<string, KeptMatch>>();
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
    });

    const sourceMap = (source: string) => {
      let map = kept.get(source);
      if (!map) kept.set(source, (map = new Map()));
      return map;
    };

    // One search per cleaned name and year, however many sources have it.
    const asked = new Map<string, Promise<TitleMatch | undefined>>();
    /** Sources saved with an older cleaning, whose matches are checked again. */
    const recheck = new Set<string>();
    /** Titles looked for since the app started. */
    const fresh = new Set<string>();

    // What's kept, once, and again if Cinemeta's address changes.
    const loadKept = async (url: string) => {
      // What's waiting is saved as the old address's, and its searches aren't used for the new one.
      clearTimeout(saveTimer);
      await flush();
      asked.clear();
      recheck.clear();
      fresh.clear();
      keptFrom = url;
      kept.clear();
      changeLog = [];
      logId++;
      try {
        for (const record of await options.store.load()) {
          if (record.cinemeta !== url) continue;
          const entries = Object.entries(record.matches);
          const current = (record.cleaning ?? 1) >= CLEANING;
          if (!current) recheck.add(record.source);
          kept.set(
            record.source,
            new Map(current ? entries : entries.filter(([, value]) => typeof value === "object")),
          );
        }
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
    const dirty = new Set<string>();
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      saveTimer = undefined;
      const sources = [...dirty];
      dirty.clear();
      for (const source of sources) {
        const matches: Record<string, KeptMatch> = {};
        for (const [key, value] of kept.get(source) ?? []) matches[key] = value;
        try {
          await options.store.save({ source, cinemeta: keptFrom, cleaning: CLEANING, matches });
        } catch (error) {
          console.warn("Couldn't keep the titles matched:", error);
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
    const changed = (source: string, found: boolean) => {
      dirty.add(source);
      saveTimer ??= setTimeout(() => void flush(), saveEveryMs);
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
          let full = meta;
          if (!meta.genres?.length && options.details)
            full = (await options.details(item.type, meta.id)) ?? meta;
          // The name is the search's, which was compared; the details only fill in what it lacked.
          const match: TitleMatch = { id: meta.id, name: meta.name, genres: full.genres ?? [], via };
          if (full.year ?? meta.year) match.year = full.year ?? meta.year;
          if (full.poster ?? meta.poster) match.poster = full.poster ?? meta.poster;
          if (full.rating ?? meta.rating) match.rating = full.rating ?? meta.rating;
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

    const record = (item: MatchItem, match: TitleMatch | undefined) => {
      sourceMap(item.source).set(
        item.key,
        match && byTmdbWay(match) ? { ...match, at: now() } : (match ?? now()),
      );
      fresh.add(item.key);
      changeLog.push(item.key);
      changed(item.source, match !== undefined);
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
      setProgress(p => ({ ...p, waitingMore: 0, askedMore: 0 }));
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
      if (typeof value === "object" && recheck.has(item.source) && !fresh.has(item.key))
        return !byTmdbWay(value) && nameKey(value.name) !== nameKey(cleanTitle(item.name, item.year).title);
      return typeof value === "number" && now() - value > RETRY_UNMATCHED_MS;
    };

    let queue: MatchItem[] = [];
    let next = 0;
    let workers = 0;
    let pausedUntil = 0;
    let round = 0;
    const work = async (mine: number) => {
      workers++;
      try {
        // A new round (round++) or a pause ends this worker.
        const going = () => mine === round && next < queue.length && now() >= pausedUntil;
        while (going()) {
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
      if (workers > 0 || laterKeys.size > 0 || laterLoops > 0) return;
      setProgress(p => ({ ...p, running: false }));
      if (publishTimer !== undefined) {
        clearTimeout(publishTimer);
        publishTimer = undefined;
        setVersion(n => n + 1);
      }
    };
    const start = () => {
      if (now() < pausedUntil) return;
      const wanted = Math.min(concurrency, Math.max(0, queue.length - next));
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
    };
  });

export type TitleMatcher = ReturnType<typeof createTitleMatcher>;
