// The modern layout's titles (PLAN.md, "Movies and Series by title", step
// 3): every source's copy of a film or series, and the add-ons' title of
// the same IMDb id, as one title. An IPTV title takes Cinemeta's name,
// poster and genres once it's matched (src/data/titleMatches.ts); unmatched
// ones with the same cleaned name and year are one title too, in their
// provider's category.

import type { AddonMeta } from "../stremio/addon";
import { cleanTitle, isImdbId, nameKey } from "../stremio/cinemeta";
import { addonFilm, addonSeries, filmKey, seriesKey } from "../stremio/vodEntries";
import { seasonsOf, type Episode, type EpisodeLink, type SeriesDetails } from "./vod";
import type { FilmEntry, SeriesEntry } from "./vodLibrary";
import type { MatchChanges, TitleMatch } from "./titleMatches";

export interface TitleFilm extends FilmEntry {
  /** Every IPTV source's copy, in source order. */
  links: FilmEntry[];
  genres: string[];
  imdb?: string;
}

export interface TitleSeries extends SeriesEntry {
  links: SeriesEntry[];
  genres: string[];
  imdb?: string;
}

/** An add-on's title found in its catalogs, with the add-on's list id. */
export interface AddonItem {
  meta: AddonMeta;
  addon: string;
}

export interface Titles<T> {
  /** In the order their first copy comes: the sources', then the add-ons'. */
  titles: T[];
  /** By IMDb id. */
  byImdb: Map<string, T>;
  /** By the title's key, and each of its links' keys. */
  byKey: Map<string, T>;
}

type MatchOf = (item: { key: string; source: string }) => TitleMatch | undefined;

/** The key an unmatched title is joined by: its cleaned name and year. */
const groups = new Map<string, string>();
const nameGroup = (name: string, year?: number) => {
  // Kept, as the titles are joined again each time matches come in.
  const asked = `${name}\u0000${year ?? ""}`;
  let group = groups.get(asked);
  if (group === undefined) {
    const clean = cleanTitle(name, year);
    group = `n:${nameKey(clean.title)}:${clean.year ?? ""}`;
    if (groups.size > 50_000) groups.clear();
    groups.set(asked, group);
  }
  return group;
};

type Joined<E> = E & { links: E[]; genres: string[]; imdb?: string };

/** How a title is made: from its match and first copy, from its first copy alone, or from an add-on's. */
interface Maker<E, T> {
  matched: (match: TitleMatch, first: E) => T;
  unmatched: (first: E) => T;
  addon: (item: AddonItem) => T;
}

const entryGroup = (entry: FilmEntry | SeriesEntry, match: TitleMatch | undefined) =>
  match ? `i:${match.id}` : nameGroup(entry.name, entry.year);
const itemGroup = (item: AddonItem) =>
  isImdbId(item.meta.id) ? `i:${item.meta.id}` : `a:${item.addon}:${item.meta.id}`;
/** An add-on's title that a source's copy has too adds what that one lacks. */
const fillFrom = (title: Joined<FilmEntry | SeriesEntry>, item: AddonItem) => {
  if (!title.poster && item.meta.poster) title.poster = item.meta.poster;
  if (title.genres.length === 0 && item.meta.genres) title.genres = item.meta.genres;
};

const merge = <E extends FilmEntry | SeriesEntry, T extends Joined<E>>(
  entries: readonly E[],
  matchOf: MatchOf,
  addonItems: readonly AddonItem[],
  make: Maker<E, T>,
): Titles<T> => {
  const byGroup = new Map<string, T>();
  const titles: T[] = [];
  const byImdb = new Map<string, T>();
  const byKey = new Map<string, T>();
  const add = (group: string, title: T) => {
    byGroup.set(group, title);
    titles.push(title);
    byKey.set(title.key, title);
    if (title.imdb) byImdb.set(title.imdb, title);
  };
  for (const entry of entries) {
    const match = matchOf(entry);
    const group = entryGroup(entry, match);
    let title = byGroup.get(group);
    if (!title) add(group, (title = match ? make.matched(match, entry) : make.unmatched(entry)));
    title.links.push(entry);
    byKey.set(entry.key, title);
  }
  for (const item of addonItems) {
    const group = itemGroup(item);
    const title = byGroup.get(group);
    if (title) fillFrom(title, item);
    else add(group, make.addon(item));
  }
  return { titles, byImdb, byKey };
};

/** Joins the titles as merge() does, and again for the matches that changed only. */
export type Merger<E, T> = (
  entries: readonly E[],
  matchOf: MatchOf,
  addonItems: readonly AddonItem[],
  changes?: MatchChanges,
) => Titles<T>;

const sameItems = (a: readonly AddonItem[], b: readonly AddonItem[]) =>
  a.length === b.length && a.every((item, i) => item.meta === b[i].meta && item.addon === b[i].addon);

/**
 * Joining a big library takes a while on a TV (about 250 ms for 37,000
 * films), and matches come in a few at a time, so after the first time
 * only the groups whose copies' matches changed are made again: the
 * titles are the same as merge()'s, in the same order. The rest keep their
 * objects, so what shows them needn't change.
 */
const createMerger = <E extends FilmEntry | SeriesEntry, T extends Joined<E>>(
  make: Maker<E, T>,
): Merger<E, T> => {
  interface State {
    entries: readonly E[];
    addonItems: readonly AddonItem[];
    logId: number;
    logAt: number;
    /** Whether each copy's key is its own, which joining again needs. */
    keysOwn: boolean;
    index: Map<string, number>;
    matchAt: Map<string, TitleMatch | undefined>;
    groupOf: Map<string, string>;
    /** Each group's copies, in order. */
    members: Map<string, E[]>;
    addonsOf: Map<string, AddonItem[]>;
    addonAt: Map<string, number>;
    byGroup: Map<string, T>;
    orderOf: Map<T, number>;
    result: Titles<T>;
  }
  let state: State | undefined;

  const build = (one: State, group: string, matchOf: MatchOf) => {
    const members = one.members.get(group) ?? [];
    const [first] = members;
    let title: T | undefined;
    if (first) {
      const match = matchOf(first);
      title = match ? make.matched(match, first) : make.unmatched(first);
      for (const entry of members) title.links.push(entry);
    }
    for (const item of one.addonsOf.get(group) ?? []) {
      if (title) fillFrom(title, item);
      else title = make.addon(item);
    }
    if (title) {
      const order = first
        ? (one.index.get(first.key) ?? 0)
        : one.entries.length + (one.addonAt.get(group) ?? 0);
      one.orderOf.set(title, order);
    }
    return title;
  };

  const full = (
    entries: readonly E[],
    matchOf: MatchOf,
    addonItems: readonly AddonItem[],
    changes: MatchChanges | undefined,
  ): State => {
    const one: State = {
      entries,
      addonItems,
      logId: changes?.id ?? -1,
      logAt: changes?.keys.length ?? 0,
      keysOwn: true,
      index: new Map(),
      matchAt: new Map(),
      groupOf: new Map(),
      members: new Map(),
      addonsOf: new Map(),
      addonAt: new Map(),
      byGroup: new Map(),
      orderOf: new Map(),
      result: { titles: [], byImdb: new Map(), byKey: new Map() },
    };
    entries.forEach((entry, i) => {
      if (one.index.has(entry.key)) one.keysOwn = false;
      const match = matchOf(entry);
      const group = entryGroup(entry, match);
      one.index.set(entry.key, i);
      one.matchAt.set(entry.key, match);
      one.groupOf.set(entry.key, group);
      const list = one.members.get(group);
      if (list) list.push(entry);
      else one.members.set(group, [entry]);
    });
    addonItems.forEach((item, i) => {
      const group = itemGroup(item);
      const list = one.addonsOf.get(group);
      if (list) list.push(item);
      else {
        one.addonsOf.set(group, [item]);
        one.addonAt.set(group, i);
      }
    });
    const { titles, byImdb, byKey } = one.result;
    const add = (group: string) => {
      const title = build(one, group, matchOf);
      if (!title) return;
      one.byGroup.set(group, title);
      titles.push(title);
      byKey.set(title.key, title);
      if (title.imdb) byImdb.set(title.imdb, title);
      for (const link of title.links) byKey.set(link.key, title);
    };
    for (const entry of entries) {
      const group = one.groupOf.get(entry.key) ?? "";
      if (one.members.get(group)?.[0] === entry) add(group);
    }
    for (const group of one.addonsOf.keys()) if (!one.members.has(group)) add(group);
    return one;
  };

  /** Moves the changed copies to their new groups, and makes those groups' titles again. */
  const update = (one: State, keys: readonly string[], from: number, matchOf: MatchOf) => {
    const affected = new Set<string>();
    for (let k = from; k < keys.length; k++) {
      const key = keys[k];
      const i = one.index.get(key);
      if (i === undefined) continue;
      const entry = one.entries[i];
      const match = matchOf(entry);
      if (match === one.matchAt.get(key)) continue;
      one.matchAt.set(key, match);
      const group = entryGroup(entry, match);
      const old = one.groupOf.get(key) ?? "";
      affected.add(group);
      if (old === group) continue;
      affected.add(old);
      one.groupOf.set(key, group);
      const leaving = one.members.get(old) ?? [];
      leaving.splice(leaving.indexOf(entry), 1);
      if (leaving.length === 0) one.members.delete(old);
      let joining = one.members.get(group);
      if (!joining) one.members.set(group, (joining = []));
      let at = joining.length;
      while (at > 0 && (one.index.get(joining[at - 1].key) ?? 0) > i) at--;
      joining.splice(at, 0, entry);
    }
    if (affected.size === 0) return;

    const { byImdb, byKey } = one.result;
    const removed = new Set<T>();
    const added: T[] = [];
    for (const group of affected) {
      const old = one.byGroup.get(group);
      if (old) {
        removed.add(old);
        one.orderOf.delete(old);
        if (byKey.get(old.key) === old) byKey.delete(old.key);
        for (const link of old.links) if (byKey.get(link.key) === old) byKey.delete(link.key);
        if (old.imdb && byImdb.get(old.imdb) === old) byImdb.delete(old.imdb);
      }
      const title = build(one, group, matchOf);
      if (title) {
        one.byGroup.set(group, title);
        added.push(title);
      } else one.byGroup.delete(group);
    }
    const titles =
      removed.size > 0 ? one.result.titles.filter(title => !removed.has(title)) : [...one.result.titles];
    const orderOf = (title: T) => one.orderOf.get(title) ?? 0;
    for (const title of added) {
      byKey.set(title.key, title);
      for (const link of title.links) byKey.set(link.key, title);
      if (title.imdb) byImdb.set(title.imdb, title);
      // Where its first copy comes, as merge() has it.
      let low = 0;
      let high = titles.length;
      const order = orderOf(title);
      while (low < high) {
        const middle = (low + high) >> 1;
        if (orderOf(titles[middle]) < order) low = middle + 1;
        else high = middle;
      }
      titles.splice(low, 0, title);
    }
    one.result = { titles, byImdb, byKey };
  };

  return (entries, matchOf, addonItems, changes) => {
    const one = state;
    const again =
      one !== undefined &&
      changes !== undefined &&
      one.keysOwn &&
      one.entries === entries &&
      one.logId === changes.id &&
      changes.keys.length >= one.logAt &&
      // Many changes at once are joined faster from the start.
      changes.keys.length - one.logAt < entries.length / 4 &&
      sameItems(one.addonItems, addonItems);
    if (!again) {
      state = full(entries, matchOf, addonItems, changes);
      return state.result;
    }
    // The add-ons' items may be new objects with the same titles.
    one.addonItems = addonItems;
    update(one, changes.keys, one.logAt, matchOf);
    one.logAt = changes.keys.length;
    // A new object each time, as merge() gives, so what reads it is told.
    return { ...one.result };
  };
};

const FILM_MAKER: Maker<FilmEntry, TitleFilm> = {
  matched: (match, first) => {
    const title: TitleFilm = {
      id: `m:${match.id}`,
      name: match.name,
      url: "",
      source: "",
      key: filmKey(match.id),
      stremio: { type: "movie", id: match.id },
      links: [],
      genres: match.genres,
      imdb: match.id,
    };
    const poster = match.poster ?? first.poster;
    if (poster) title.poster = poster;
    const year = match.year ?? first.year;
    if (year) title.year = year;
    if (first.rating) title.rating = first.rating;
    if (first.added) title.added = first.added;
    return title;
  },
  unmatched: first => ({ ...first, links: [], genres: [] }),
  addon: ({ meta, addon }) => ({
    ...addonFilm(meta, addon),
    links: [],
    genres: meta.genres ?? [],
    ...(isImdbId(meta.id) ? { imdb: meta.id } : {}),
  }),
};

export const mergeFilms = (
  films: readonly FilmEntry[],
  matchOf: MatchOf,
  addonItems: readonly AddonItem[] = [],
): Titles<TitleFilm> => merge(films, matchOf, addonItems, FILM_MAKER);
/** mergeFilms(), joined again for the matches that changed only. */
export const createFilmMerger = () => createMerger(FILM_MAKER);

const SERIES_MAKER: Maker<SeriesEntry, TitleSeries> = {
  matched: (match, first) => {
    const title: TitleSeries = {
      id: `s:${match.id}`,
      name: match.name,
      source: "",
      key: seriesKey(match.id),
      stremio: { type: "series", id: match.id },
      links: [],
      genres: match.genres,
      imdb: match.id,
    };
    const poster = match.poster ?? first.poster;
    if (poster) title.poster = poster;
    const year = match.year ?? first.year;
    if (year) title.year = year;
    if (first.rating) title.rating = first.rating;
    if (first.plot) title.plot = first.plot;
    return title;
  },
  // Without its episodes: they're joined from every copy's (mergeEpisodes).
  unmatched: first => ({ ...first, links: [], genres: [] }),
  addon: ({ meta, addon }) => ({
    ...addonSeries(meta, addon),
    links: [],
    genres: meta.genres ?? [],
    ...(isImdbId(meta.id) ? { imdb: meta.id } : {}),
  }),
};

export const mergeSeries = (
  series: readonly SeriesEntry[],
  matchOf: MatchOf,
  addonItems: readonly AddonItem[] = [],
): Titles<TitleSeries> => merge(series, matchOf, addonItems, SERIES_MAKER);
/** mergeSeries(), joined again for the matches that changed only. */
export const createSeriesMerger = () => createMerger(SERIES_MAKER);

const numberOf = (episode: Episode) => `${episode.season}:${episode.episode}`;

/**
 * A series' episodes from Cinemeta or an add-on (`base`) and from each
 * source's copy, as one list: the same season and number is one episode,
 * with each source's as a link. Episodes only a source has are added.
 */
export const mergeEpisodes = (
  base: SeriesDetails | undefined,
  copies: readonly { show: EpisodeLink["show"]; details: SeriesDetails }[],
): SeriesDetails => {
  const byNumber = new Map<string, Episode>();
  const all: Episode[] = [];
  for (const season of base?.seasons ?? []) {
    for (const episode of season.episodes) {
      const merged = { ...episode, links: [] };
      byNumber.set(numberOf(episode), merged);
      all.push(merged);
    }
  }
  for (const { show, details } of copies) {
    for (const season of details.seasons) {
      for (const episode of season.episodes) {
        let merged = byNumber.get(numberOf(episode));
        if (!merged) {
          // The first copy's episode is the title's, so it keeps its id and address.
          merged = { ...episode, links: [] };
          byNumber.set(numberOf(episode), merged);
          all.push(merged);
        }
        merged.links?.push({ show, episode });
      }
    }
  }
  const first = copies[0]?.details;
  const seasons = seasonsOf(all);
  const details: SeriesDetails = {
    seasons: [...seasons.filter(one => one.season !== 0), ...seasons.filter(one => one.season === 0)],
  };
  const plot = base?.plot ?? first?.plot;
  if (plot) details.plot = plot;
  const cast = base?.cast ?? first?.cast;
  if (cast) details.cast = cast;
  const genre = base?.genre ?? first?.genre;
  if (genre) details.genre = genre;
  const backdrop = base?.backdrop ?? first?.backdrop;
  if (backdrop) details.backdrop = backdrop;
  return details;
};
