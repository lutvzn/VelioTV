// "More like this" on a film's or series' page (PLAN.md, "Movies and Series
// by title"): the titles TMDB recommends for it, when TMDB is used. Kept in
// memory for the session, a few dozen titles' worth.
//
// After NuvioTVSmart's TMDB recommendations on its detail page
// (https://github.com/NuvioMedia/NuvioTVSmart, GPL-3.0); changed: written
// in TypeScript for this app's TMDB client and pages.

import type { Tmdb, TmdbFound, TmdbType } from "../stremio/tmdb";

export type Similar = TmdbFound;

/** Titles whose recommendations are kept. */
const KEPT = 30;
/** Shown at most. */
export const SIMILAR_SHOWN = 20;

export interface SimilarTo {
  tmdb?: number;
  /** "tt…", when it's known. */
  imdb?: string;
}

/** `make()`'s promise for `key`, kept in `map`, the least used dropped past KEPT. */
const keep = <T>(map: Map<string, Promise<T>>, key: string, make: () => Promise<T>) => {
  const found = map.get(key);
  if (found) {
    // Last used, last out.
    map.delete(key);
    map.set(key, found);
    return found;
  }
  const made = make();
  map.set(key, made);
  // One that failed is asked for again next time.
  made.catch(() => map.delete(key));
  while (map.size > KEPT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return made;
};

export const createMoreLikeThis = (options: { tmdb: () => Tmdb | undefined }) => {
  const kept = new Map<string, Promise<Similar[]>>();
  const imdbs = new Map<string, Promise<string | undefined>>();
  return {
    /** TMDB's recommendations for a title; none without TMDB or an id. */
    of: (type: TmdbType, title: SimilarTo): Promise<Similar[]> => {
      const tmdb = options.tmdb();
      if (!tmdb || (!title.tmdb && !title.imdb)) return Promise.resolve([]);
      return keep(kept, `${type} ${title.tmdb ?? title.imdb}`, async () => {
        const id = title.tmdb ?? (title.imdb ? await tmdb.byImdb(type, title.imdb) : undefined);
        if (!id) return [];
        return (await tmdb.recommendations(type, id)).slice(0, SIMILAR_SHOWN);
      });
    },
    /** A recommended title's IMDb id, to open it with the add-ons. */
    imdbOf: (type: TmdbType, id: number): Promise<string | undefined> => {
      const tmdb = options.tmdb();
      if (!tmdb) return Promise.resolve(undefined);
      return keep(imdbs, `${type} ${id}`, async () => (await tmdb.title(type, id))?.imdb);
    },
  };
};

export type MoreLikeThis = ReturnType<typeof createMoreLikeThis>;
