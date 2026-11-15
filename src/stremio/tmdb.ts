// TMDB (The Movie Database), for matching the sources' titles Cinemeta's search
// doesn't find (PLAN.md, "Movies and Series by title"): its search knows
// titles in many languages and other names, and a title's details give its
// IMDb id, which Stremio's add-ons share. Used only with an API key, under
// TMDB's terms for non-commercial apps: its logo and notice are in Settings.

import { nameKey } from "./cinemeta";

export const TMDB_URL = "https://api.themoviedb.org/3";
const POSTERS = "https://image.tmdb.org/t/p/w342";

export type TmdbType = "movie" | "series";

/** A search result. */
export interface TmdbFound {
  id: number;
  title: string;
  /** In the title's own language. */
  originalTitle: string;
  year?: number;
}

/** A title's details, in English. */
export interface TmdbTitle {
  tmdb: number;
  imdb?: string;
  name: string;
  year?: number;
  /** As Cinemeta names them, so the two make the same genre rows. */
  genres: string[];
  poster?: string;
  /** TMDB's users' score out of 10, when enough have voted. */
  rating?: number;
}

/** Votes a TMDB score needs to be shown: a few votes say little. */
const MIN_VOTES = 10;

/** TMDB's genres that Cinemeta names otherwise; a TV genre may be two. */
const GENRES: Record<string, string[]> = {
  "Science Fiction": ["Sci-Fi"],
  "TV Movie": [],
  "Action & Adventure": ["Action", "Adventure"],
  "Sci-Fi & Fantasy": ["Sci-Fi", "Fantasy"],
  "War & Politics": ["War"],
  Kids: ["Family"],
  Reality: ["Reality-TV"],
  Talk: ["Talk-Show"],
  Soap: ["Drama"],
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const yearOf = (value: unknown) => {
  const year = Number(text(value).slice(0, 4));
  return year > 1800 ? year : undefined;
};

export const readTmdbResults = (value: unknown, type: TmdbType): TmdbFound[] => {
  const results = isObject(value) ? value.results : undefined;
  if (!Array.isArray(results)) return [];
  const found: TmdbFound[] = [];
  for (const one of results as unknown[]) {
    if (!isObject(one) || typeof one.id !== "number") continue;
    const title = text(type === "movie" ? one.title : one.name);
    if (!title) continue;
    const result: TmdbFound = {
      id: one.id,
      title,
      originalTitle: text(type === "movie" ? one.original_title : one.original_name) || title,
    };
    const year = yearOf(type === "movie" ? one.release_date : one.first_air_date);
    if (year) result.year = year;
    found.push(result);
  }
  return found;
};

export const readTmdbTitle = (value: unknown, type: TmdbType): TmdbTitle | undefined => {
  if (!isObject(value) || typeof value.id !== "number") return undefined;
  const name = text(type === "movie" ? value.title : value.name);
  if (!name) return undefined;
  const genres: string[] = [];
  if (Array.isArray(value.genres)) {
    for (const genre of value.genres as unknown[]) {
      const genreName = isObject(genre) ? text(genre.name) : "";
      for (const one of GENRES[genreName] ?? (genreName ? [genreName] : []))
        if (!genres.includes(one)) genres.push(one);
    }
  }
  const title: TmdbTitle = { tmdb: value.id, name, genres };
  const ids = isObject(value.external_ids) ? value.external_ids : {};
  const imdb = text(ids.imdb_id) || text(value.imdb_id);
  if (/^tt\d+$/.test(imdb)) title.imdb = imdb;
  const year = yearOf(type === "movie" ? value.release_date : value.first_air_date);
  if (year) title.year = year;
  const poster = text(value.poster_path);
  if (poster.startsWith("/")) title.poster = `${POSTERS}${poster}`;
  const votes = typeof value.vote_count === "number" ? value.vote_count : 0;
  if (typeof value.vote_average === "number" && value.vote_average > 0 && votes >= MIN_VOTES)
    title.rating = Math.round(value.vote_average * 10) / 10;
  return title;
};

/**
 * The result that is this title: the same name, in English or its own
 * language, and a year no more than one off, the nearest. Without a year,
 * only a name no other result has, so two films aren't joined by a guess.
 */
export const pickTmdb = (found: readonly TmdbFound[], title: string, year?: number) => {
  const wanted = nameKey(title);
  if (!wanted) return undefined;
  const same = found.filter(one => nameKey(one.title) === wanted || nameKey(one.originalTitle) === wanted);
  if (year === undefined) return same.length === 1 ? same[0] : undefined;
  let best: TmdbFound | undefined;
  let bestOff = 2;
  for (const one of same) {
    const off = one.year === undefined ? 2 : Math.abs(one.year - year);
    if (off < bestOff) {
      best = one;
      bestOff = off;
    }
  }
  return best;
};

/** The edits that make one name another, or `most + 1` once there are more. */
export const editsBetween = (a: string, b: string, most: number) => {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const edits = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + cost);
      next.push(edits);
      if (edits < least) least = edits;
    }
    if (least > most) return most + 1;
    row = next;
  }
  return row[b.length];
};

/** The spelling a long name may differ by: "Bāhubali" for "Baahubali". */
const closeEnough = (length: number) => (length >= 16 ? 2 : length >= 8 ? 1 : 0);

/**
 * When no result has the same name: the one whose name is spelled a little
 * differently, of the same year exactly, if only one is. A short name must
 * be the same.
 */
export const pickCloseTmdb = (found: readonly TmdbFound[], title: string, year: number) => {
  const wanted = nameKey(title);
  const most = closeEnough(wanted.length);
  if (most === 0) return undefined;
  const close = found.filter(
    one =>
      one.year === year &&
      (editsBetween(nameKey(one.title), wanted, most) <= most ||
        editsBetween(nameKey(one.originalTitle), wanted, most) <= most),
  );
  return close.length === 1 ? close[0] : undefined;
};

export interface TmdbOptions {
  key: () => string;
  url?: () => string;
  fetch?: typeof fetch;
  /** Requests at once. */
  atOnce?: number;
}

export const createTmdb = (options: TmdbOptions) => {
  const url = options.url ?? (() => TMDB_URL);
  const fetcher = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const atOnce = options.atOnce ?? 8;
  let running = 0;
  const waiting: (() => void)[] = [];

  /** The answer, or undefined when TMDB has no such title. */
  const get = async (path: string, params: Record<string, string | number | undefined>) => {
    if (running >= atOnce) await new Promise<void>(resolve => waiting.push(resolve));
    running++;
    try {
      // The key as a parameter, not a header, so the browser needs no preflight.
      const query = Object.keys(params)
        .filter(name => params[name] !== undefined && params[name] !== "")
        .map(name => `${name}=${encodeURIComponent(String(params[name]))}`);
      query.push(`api_key=${encodeURIComponent(options.key())}`);
      const response = await fetcher(`${url()}${path}?${query.join("&")}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`TMDB answered HTTP ${response.status}`);
      return (await response.json()) as unknown;
    } finally {
      running--;
      waiting.shift()?.();
    }
  };

  return {
    /** Titles by name; `language` (such as "es") also searches and gives the titles in it. */
    search: async (
      type: TmdbType,
      query: string,
      { year, language }: { year?: number; language?: string } = {},
    ) => {
      const answer =
        type === "movie"
          ? await get("/search/movie", { query, year, language })
          : await get("/search/tv", { query, first_air_date_year: year, language });
      return readTmdbResults(answer, type);
    },
    /** A title's details and IMDb id, by its TMDB id. */
    title: async (type: TmdbType, id: number) => {
      const answer = await get(`/${type === "movie" ? "movie" : "tv"}/${id}`, {
        append_to_response: "external_ids",
        language: "en-US",
      });
      return readTmdbTitle(answer, type);
    },
  };
};

export type Tmdb = ReturnType<typeof createTmdb>;
