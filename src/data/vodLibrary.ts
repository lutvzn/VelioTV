// Every source's films and series, in memory, for the Movies and Series
// pages (PLAN.md, Phase 6, step 4). Like the lineup (lineup.ts), a source's
// record is read from the database once, and again when an import of it
// finishes. A film's details and a series' episodes come from the server
// when first opened (vod.ts), and are kept while the app runs.

import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { openDb, readVod, type ImportState } from "./db";
import type { Source } from "./sources";
import {
  seasonsOf,
  xtreamFilmInfo,
  xtreamSeriesInfo,
  type Film,
  type FilmDetails,
  type Series,
  type SeriesDetails,
  type StoredVod,
} from "./vod";
import type { XtreamLogin } from "./xtream";
import { ensureFetch } from "../polyfills/fetch";

ensureFetch();

/** A title from a Stremio add-on (src/stremio/): its type and id there. */
export interface StremioTitle {
  type: "movie" | "series";
  id: string;
}

export interface FilmEntry extends Film {
  /** The source's id, or the add-on's list id for one from an add-on. */
  source: string;
  /** "<source>/m:<id>", as the resume list keys it; "stremio:movie:<id>" from an add-on. */
  key: string;
  stremio?: StremioTitle;
}

export interface SeriesEntry extends Series {
  source: string;
  /** "<source>/s:<id>"; "stremio:series:<id>" from an add-on. */
  key: string;
  stremio?: StremioTitle;
}

/** Details of the add-ons' titles, which the add-ons give (src/stremio/vodEntries.ts). */
export interface AddonDetails {
  film: (film: FilmEntry) => Promise<FilmDetails>;
  series: (show: SeriesEntry) => Promise<SeriesDetails>;
}

export interface VodLibraryOptions {
  sources: () => Source[];
  stateOf: (id: string) => ImportState | undefined;
  read?: (source: string) => Promise<StoredVod>;
  fetch?: typeof fetch;
  dbName?: string;
  addons?: AddonDetails;
}

const versionOf = (state: ImportState) => `${state.status}:${state.startedAt}`;

/** Keeps a request's answer, or forgets it if it failed, so it's asked again. */
const cached = <T>(cache: Map<string, Promise<T>>, key: string, ask: () => Promise<T>) => {
  let found = cache.get(key);
  if (!found) {
    found = ask();
    cache.set(key, found);
    found.catch(() => cache.delete(key));
  }
  return found;
};

/** A source's Xtream login, for details from its server. */
export const loginOf = (source: Source | undefined): XtreamLogin | undefined =>
  source?.kind === "xtream" && source.server && source.username !== undefined
    ? { server: source.server, username: source.username, password: source.password ?? "" }
    : undefined;

/** Categories in the order their first item appears. */
const categoriesOf = (items: readonly { category?: string }[]) => {
  const seen = new Set<string>();
  for (const item of items) if (item.category) seen.add(item.category);
  return [...seen];
};

export const createVodLibrary = (options: VodLibraryOptions) =>
  createRoot(() => {
    let dbPromise: Promise<IDBDatabase> | undefined;
    const read =
      options.read ??
      (async (source: string) => readVod(await (dbPromise ??= openDb(options.dbName)), source));
    const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

    const [stored, setStored] = createSignal<Record<string, { version: string; vod: StoredVod }>>({});
    const [loading, setLoading] = createSignal(0);
    const reading = new Map<string, string>();

    const load = async (source: string, version: string) => {
      reading.set(source, version);
      setLoading(n => n + 1);
      try {
        const vod = await read(source);
        if (reading.get(source) === version) setStored(all => ({ ...all, [source]: { version, vod } }));
      } catch (error) {
        console.error("Couldn't read a source's films and series:", error);
      } finally {
        if (reading.get(source) === version) reading.delete(source);
        setLoading(n => n - 1);
      }
    };

    createEffect(() => {
      const current = stored();
      const ids = new Set<string>();
      for (const source of options.sources()) {
        ids.add(source.id);
        const state = options.stateOf(source.id);
        if (!state) continue;
        const loaded = current[source.id];
        const version = versionOf(state);
        const wanted = state.status === "importing" ? !loaded : loaded?.version !== version;
        if (wanted && reading.get(source.id) !== version) void load(source.id, version);
      }
      const stale = Object.keys(current).filter(id => !ids.has(id) || !options.stateOf(id));
      if (stale.length > 0) {
        setStored(all => {
          const next = { ...all };
          for (const id of stale) delete next[id];
          return next;
        });
      }
    });

    const films = createMemo((): FilmEntry[] =>
      options.sources().flatMap(
        source =>
          stored()[source.id]?.vod.films.map(film => ({
            ...film,
            source: source.id,
            key: `${source.id}/${film.id}`,
          })) ?? [],
      ),
    );
    const series = createMemo((): SeriesEntry[] =>
      options.sources().flatMap(
        source =>
          stored()[source.id]?.vod.series.map(show => ({
            ...show,
            source: source.id,
            key: `${source.id}/${show.id}`,
          })) ?? [],
      ),
    );
    const filmsByKey = createMemo(() => new Map(films().map(film => [film.key, film])));
    const seriesByKey = createMemo(() => new Map(series().map(show => [show.key, show])));
    const filmCategories = createMemo(() => categoriesOf(films()));
    const seriesCategories = createMemo(() => categoriesOf(series()));

    const sourceOf = (id: string) => options.sources().find(source => source.id === id);
    const filmInfo = new Map<string, Promise<FilmDetails>>();
    const seriesInfo = new Map<string, Promise<SeriesDetails>>();

    return {
      /** Every film, in source order, then the source's order. */
      films,
      series,
      filmCategories,
      seriesCategories,
      findFilm: (key: string) => filmsByKey().get(key),
      findSeries: (key: string) => seriesByKey().get(key),
      loading: () => loading() > 0,

      /** A film's details; an M3U film has none. */
      filmDetails: (film: FilmEntry): Promise<FilmDetails> => {
        if (film.stremio) return options.addons?.film(film) ?? Promise.resolve({});
        const login = loginOf(sourceOf(film.source));
        const id = film.providerId;
        if (!login || !id) return Promise.resolve({});
        return cached(filmInfo, film.key, () => xtreamFilmInfo(login, id, fetcher));
      },

      /**
       * A film's TMDB id from its Xtream account, which the list of films
       * doesn't give, for matching it to Cinemeta. Not kept.
       */
      filmTmdb: async (film: FilmEntry): Promise<number | undefined> => {
        const login = loginOf(sourceOf(film.source));
        const id = film.providerId;
        if (film.stremio || !login || !id) return undefined;
        return (await xtreamFilmInfo(login, id, fetcher)).tmdb;
      },

      /** A series' details and episodes: an M3U series has its episodes already. */
      seriesDetails: (show: SeriesEntry): Promise<SeriesDetails> => {
        if (show.stremio) return options.addons?.series(show) ?? Promise.resolve({ seasons: [] });
        if (show.episodes) return Promise.resolve({ plot: show.plot, seasons: seasonsOf(show.episodes) });
        const login = loginOf(sourceOf(show.source));
        const id = show.providerId;
        if (!login || !id) return Promise.resolve({ seasons: [] });
        return cached(seriesInfo, show.key, () => xtreamSeriesInfo(login, id, fetcher));
      },
    };
  });

export type VodLibrary = ReturnType<typeof createVodLibrary>;
