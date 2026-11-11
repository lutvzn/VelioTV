// The title matcher's other ways to find a title (src/data/titleMatches.ts,
// PLAN.md, "Movies and Series by title"), besides Cinemeta's search by name:
//
// - With TMDB (an API key): a TMDB id from the list gives the title's
//   details and IMDb id, and a title the name didn't find is searched for
//   on TMDB, in the language its tag gives, by its name and the other names
//   the cleaning gives, taking only the same name and year, or a name
//   spelled a little differently of the very same year.
// - Then, or without TMDB: an Xtream film's provider is asked for its TMDB
//   id, one film at a time, as it's slow; and a TMDB id without TMDB is
//   turned into an IMDb id by Wikidata, with Cinemeta's details.
//
// TMDB's searches and the provider each have their own queue, so the
// provider's slow answers don't hold up the searches: they all finish
// first, and the provider goes on after.

import type { AddonMeta } from "../stremio/addon";
import { cleanTitle, nameKey, tagLanguage } from "../stremio/cinemeta";
import { pickCloseTmdb, pickTmdb, type Tmdb, type TmdbFound, type TmdbTitle } from "../stremio/tmdb";
import { agrees, type MatchedBy, type MatchItem, type TitleMatch, type TitleType } from "./titleMatches";

export interface MoreMatchesOptions {
  /** TMDB, while it has a key. */
  tmdb: () => Tmdb | undefined;
  /** The IMDb id for a TMDB id, as Wikidata gives it. */
  imdbOfTmdb: (type: TitleType, tmdb: number) => Promise<string | undefined>;
  /** Cinemeta's details for an IMDb id. */
  details: (type: TitleType, imdb: string) => Promise<AddonMeta | undefined>;
  /** A film's TMDB id from its provider, for one with `askTmdb`. */
  providerTmdb: (item: MatchItem) => Promise<number | undefined>;
}

/**
 * Titles the matcher hands over at once: all of them, as each way has its
 * own queue below.
 */
export const MORE_AT_ONCE = 100_000;
/** Titles searched for on TMDB at once; its requests are limited on their own (src/stremio/tmdb.ts). */
const SEARCHES_AT_ONCE = 16;
/** Cinemeta's details asked for at once. */
const DETAILS_AT_ONCE = 4;
/** TMDB searches for one title, at most. */
const MOST_SEARCHES = 6;

/** Runs at most `most` of the tasks at once, in the order given. */
const limited = (most: number) => {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= most) await new Promise<void>(resolve => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
};

/** TMDB's title as a match; one without an IMDb id can't be joined with the add-ons'. */
const fromTmdb = (title: TmdbTitle | undefined, via: MatchedBy): TitleMatch | undefined => {
  if (!title?.imdb) return undefined;
  const match: TitleMatch = { id: title.imdb, name: title.name, genres: title.genres, via };
  if (title.year) match.year = title.year;
  if (title.poster) match.poster = title.poster;
  return match;
};

interface Search {
  title: string;
  /** TMDB's year filter, and the year the result must have. */
  year?: number;
  /** The result's year, when the search has none. */
  near?: number;
}

/**
 * What to search TMDB for: the cleaned name with its year, then without
 * (the provider's is often one off), the cleaning's other names ("Harry
 * Potter And The Philosopher's Stone" for "Harry-Potter-1-Harry-Potter-And-
 * The-Philosopher-s-Stone"), and the name with the year as part of it, as
 * for "Wonder-Woman (1984)" or "Blade-Runner-2-Blade-Runner (2049)".
 */
export const tmdbSearches = (name: string, year?: number): Search[] => {
  const clean = cleanTitle(name, year);
  const searches: Search[] = [{ title: clean.title, year: clean.year }];
  if (clean.year !== undefined) searches.push({ title: clean.title, near: clean.year });
  // The likeliest first, as only MOST_SEARCHES are made.
  const [first, second, ...rest] = clean.others;
  for (const other of [first, second]) if (other) searches.push({ title: other.title, year: other.year });
  if (clean.year !== undefined) {
    searches.push({ title: `${clean.title} ${clean.year}` });
    if (first) searches.push({ title: `${first.title} ${clean.year}` });
  }
  for (const other of rest) searches.push({ title: other.title, year: other.year });
  const seen = new Set<string>();
  return searches
    .filter(one => {
      const key = `${nameKey(one.title)}/${one.year ?? ""}/${one.near ?? ""}`;
      if (nameKey(one.title).length < 2 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MOST_SEARCHES);
};

/** TMDB's search for a title, in its tag's language, by each of its names in turn. */
const searchTmdb = async (tmdb: Tmdb, item: MatchItem, wanted: () => boolean) => {
  const language = tagLanguage(item.name) ?? tagLanguage(item.category);
  const clean = cleanTitle(item.name, item.year);
  let closest: TmdbFound | undefined;
  for (const search of tmdbSearches(item.name, item.year)) {
    if (!wanted()) return undefined;
    const found = await tmdb.search(item.type, search.title, { year: search.year, language });
    const pick = pickTmdb(found, search.title, search.year ?? search.near);
    if (pick) return fromTmdb(await tmdb.title(item.type, pick.id), "tmdbSearch");
    // Spelled differently, of the same year: only if no name is the same.
    if (!closest && clean.year !== undefined && search.title === clean.title)
      closest = pickCloseTmdb(found, clean.title, clean.year);
  }
  return closest && wanted() ? fromTmdb(await tmdb.title(item.type, closest.id), "tmdbClose") : undefined;
};

export const createMoreMatches = (options: MoreMatchesOptions) => {
  const searchTurn = limited(SEARCHES_AT_ONCE);
  const providerTurn = limited(1);
  const detailsTurn = limited(DETAILS_AT_ONCE);

  const byTmdb = async (type: TitleType, id: number): Promise<TitleMatch | undefined> => {
    const tmdb = options.tmdb();
    if (tmdb) return fromTmdb(await tmdb.title(type, id), "tmdb");
    const imdb = await options.imdbOfTmdb(type, id);
    if (!imdb) return undefined;
    const meta = await detailsTurn(() => options.details(type, imdb));
    // Cinemeta doesn't have it, so it couldn't be shown as Cinemeta's.
    if (!meta) return undefined;
    const match: TitleMatch = { id: imdb, name: meta.name, genres: meta.genres ?? [], via: "tmdb" };
    if (meta.year) match.year = meta.year;
    if (meta.poster) match.poster = meta.poster;
    return match;
  };

  return {
    byTmdb,
    /**
     * TMDB's search, then the provider's TMDB id; else what the name found.
     * Null once it's no longer `wanted`, as when matching is turned off.
     */
    findMore: async (item: MatchItem, byName: TitleMatch | undefined, wanted: () => boolean = () => true) => {
      const tmdb = options.tmdb();
      if (tmdb) {
        const found = await searchTurn(() => searchTmdb(tmdb, item, wanted));
        if (found) return found;
      }
      if (item.askTmdb && item.tmdb === undefined) {
        const id = await providerTurn(async () => (wanted() ? options.providerTmdb(item) : null));
        if (id === null) return null;
        const found = id === undefined ? undefined : await byTmdb(item.type, id);
        if (found && agrees(item, found)) return found;
      }
      return wanted() ? byName : null;
    },
  };
};
