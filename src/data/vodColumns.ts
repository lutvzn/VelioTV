// A source's films and series as stored: like a channel list
// (channelList.ts), a column (array) per field rather than an object per film,
// series and episode. On the TV, 60,000 films and 3,560 series of 60,000
// episodes, stored as objects, took 2.5 s to store in the worker and 2.3 s to
// read on the page, which froze it (PLAN.md, Faster playlist imports).

import type { Episode, Film, Series, StoredVod } from "./vod";

/** A column per field: null where an item has none, no column when none has it. */
type Columns<T> = { [K in keyof T]-?: (NonNullable<T[K]> | null)[] };

export interface Table<T> {
  count: number;
  columns: Partial<Columns<T>>;
}

/** A series' episodes are stored apart, in one table: this is how many are its. */
type StoredSeries = Omit<Series, "episodes"> & { episodes?: number };
/**
 * Only an add-on's episodes have a Stremio id, and only an Xtream series'
 * the server's look at the file (FileQuality); neither is stored.
 */
type StoredEpisode = Omit<Episode, "stremio" | "links" | "released" | "height" | "estimatedBytes">;

export interface VodColumns {
  films: Table<Film>;
  series: Table<StoredSeries>;
  /** Every series' episodes, a series after another, in the order of `series`. */
  episodes: Table<StoredEpisode>;
}

// The import's worker runs as ES5 (PLAN.md, Phase 8, step 4), so these loop
// by index, and read each field by name: reading items[i][field] for a list
// of fields was 450 ms of a profile for the films and episodes above on the TV.
const columnOf = <T>(count: number): (T | null)[] => Array.from({ length: count });

/** The table of `count` items, without the columns no item has a value in. */
const tableOf = <T>(count: number, all: Columns<T>): Table<T> => {
  const columns: Partial<Columns<T>> = {};
  for (const field in all) {
    const column = all[field];
    for (let i = 0; i < count; i++) {
      if (column[i] !== null) {
        columns[field] = column;
        break;
      }
    }
  }
  return { count, columns };
};

const filmTable = (films: readonly Film[]): Table<Film> => {
  const count = films.length;
  const all: Columns<Film> = {
    id: columnOf(count),
    name: columnOf(count),
    url: columnOf(count),
    poster: columnOf(count),
    category: columnOf(count),
    headers: columnOf(count),
    rating: columnOf(count),
    year: columnOf(count),
    added: columnOf(count),
    providerId: columnOf(count),
  };
  for (let i = 0; i < count; i++) {
    const film = films[i];
    all.id[i] = film.id;
    all.name[i] = film.name;
    all.url[i] = film.url;
    all.poster[i] = film.poster ?? null;
    all.category[i] = film.category ?? null;
    all.headers[i] = film.headers ?? null;
    all.rating[i] = film.rating ?? null;
    all.year[i] = film.year ?? null;
    all.added[i] = film.added ?? null;
    all.providerId[i] = film.providerId ?? null;
  }
  return tableOf(count, all);
};

/** The series' table, and their episodes', a series' after another. */
const seriesTables = (series: readonly Series[]) => {
  const count = series.length;
  const all: Columns<StoredSeries> = {
    id: columnOf(count),
    name: columnOf(count),
    poster: columnOf(count),
    category: columnOf(count),
    rating: columnOf(count),
    year: columnOf(count),
    plot: columnOf(count),
    added: columnOf(count),
    providerId: columnOf(count),
    tmdb: columnOf(count),
    episodes: columnOf(count),
  };
  const episodes: Columns<StoredEpisode> = {
    id: [],
    season: [],
    episode: [],
    title: [],
    url: [],
    headers: [],
    plot: [],
    durationMs: [],
  };
  let episodeCount = 0;
  for (let i = 0; i < count; i++) {
    const show = series[i];
    all.id[i] = show.id;
    all.name[i] = show.name;
    all.poster[i] = show.poster ?? null;
    all.category[i] = show.category ?? null;
    all.rating[i] = show.rating ?? null;
    all.year[i] = show.year ?? null;
    all.plot[i] = show.plot ?? null;
    all.added[i] = show.added ?? null;
    all.providerId[i] = show.providerId ?? null;
    all.tmdb[i] = show.tmdb ?? null;
    const own = show.episodes;
    all.episodes[i] = own ? own.length : null;
    if (!own) continue;
    for (let e = 0; e < own.length; e++) {
      const episode = own[e];
      const at = episodeCount++;
      episodes.id[at] = episode.id;
      episodes.season[at] = episode.season;
      episodes.episode[at] = episode.episode;
      episodes.title[at] = episode.title;
      episodes.url[at] = episode.url;
      episodes.headers[at] = episode.headers ?? null;
      episodes.plot[at] = episode.plot ?? null;
      episodes.durationMs[at] = episode.durationMs ?? null;
    }
  }
  return { series: tableOf(count, all), episodes: tableOf(episodeCount, episodes) };
};

export const toVodColumns = (vod: Pick<StoredVod, "films" | "series">): VodColumns => {
  const { series, episodes } = seriesTables(vod.series);
  return { films: filmTable(vod.films), series, episodes };
};

/**
 * The films and series back. As with channels, each is built in one literal
 * with the same fields, missing ones undefined.
 */
export const fromVodColumns = (columns: VodColumns): Pick<StoredVod, "films" | "series"> => {
  const f = columns.films.columns;
  const films: Film[] = Array.from({ length: columns.films.count });
  for (let i = 0; i < films.length; i++) {
    films[i] = {
      id: f.id?.[i] ?? "",
      name: f.name?.[i] ?? "",
      url: f.url?.[i] ?? "",
      poster: f.poster?.[i] ?? undefined,
      category: f.category?.[i] ?? undefined,
      headers: f.headers?.[i] ?? undefined,
      rating: f.rating?.[i] ?? undefined,
      year: f.year?.[i] ?? undefined,
      added: f.added?.[i] ?? undefined,
      providerId: f.providerId?.[i] ?? undefined,
    };
  }

  const e = columns.episodes.columns;
  const episodeAt = (i: number): Episode => ({
    id: e.id?.[i] ?? "",
    season: e.season?.[i] ?? 0,
    episode: e.episode?.[i] ?? 0,
    title: e.title?.[i] ?? "",
    url: e.url?.[i] ?? "",
    headers: e.headers?.[i] ?? undefined,
    plot: e.plot?.[i] ?? undefined,
    durationMs: e.durationMs?.[i] ?? undefined,
  });
  const s = columns.series.columns;
  const series: Series[] = Array.from({ length: columns.series.count });
  let next = 0;
  for (let i = 0; i < series.length; i++) {
    const count = s.episodes?.[i] ?? undefined;
    let episodes: Episode[] | undefined;
    if (count !== undefined) {
      episodes = Array.from({ length: count });
      for (let n = 0; n < count; n++) episodes[n] = episodeAt(next++);
    }
    series[i] = {
      id: s.id?.[i] ?? "",
      name: s.name?.[i] ?? "",
      poster: s.poster?.[i] ?? undefined,
      category: s.category?.[i] ?? undefined,
      rating: s.rating?.[i] ?? undefined,
      year: s.year?.[i] ?? undefined,
      plot: s.plot?.[i] ?? undefined,
      added: s.added?.[i] ?? undefined,
      episodes,
      providerId: s.providerId?.[i] ?? undefined,
      tmdb: s.tmdb?.[i] ?? undefined,
    };
  }
  return { films, series };
};
