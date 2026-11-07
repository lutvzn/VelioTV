// Films and series (PLAN.md, Phase 6, step 3): what an import keeps of them,
// one record per source in the database's "vod" store.
//
// From an Xtream account they come from player_api.php: the film and series
// lists at import, and a film's details or a series' episodes when the user
// opens it (xtreamFilmInfo, xtreamSeriesInfo). From an M3U playlist they are
// entries that aren't channels: those whose URL has /movie/ or /series/ in
// its path, as Xtream panels write them in get.php, or is a video file, such
// as .mp4 or .mkv. Episodes, named like "Show S01 E02", are gathered into
// their series.
//
// Ids stay the same from one import to the next, so where a film was left
// (src/data/watched.ts) still finds it: the provider's id where the URL has
// one, or else the name.

import type { PlaylistChannel, StreamHeaders } from "./types";
import { normalizeServer, playerApiUrl, type XtreamLogin } from "./xtream";

export interface Film {
  /** "m:<id>" */
  id: string;
  name: string;
  url: string;
  poster?: string;
  category?: string;
  headers?: StreamHeaders;
  rating?: number;
  year?: number;
  /** When the server added it, in milliseconds since 1970. */
  added?: number;
  /** The Xtream stream_id, for its details. */
  providerId?: string;
}

export interface Episode {
  /** "e:<id>" */
  id: string;
  season: number;
  episode: number;
  title: string;
  url: string;
  headers?: StreamHeaders;
  plot?: string;
  durationMs?: number;
}

export interface Series {
  /** "s:<id>" */
  id: string;
  name: string;
  poster?: string;
  category?: string;
  rating?: number;
  year?: number;
  plot?: string;
  /** From an M3U playlist; an Xtream series' come with its details. */
  episodes?: Episode[];
  /** The Xtream series_id, for its episodes. */
  providerId?: string;
}

/** What the database keeps of a source's films and series. */
export interface StoredVod {
  source: string;
  films: Film[];
  series: Series[];
}

/** A film's details, from the server when it's opened. */
export interface FilmDetails {
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  durationMs?: number;
  year?: number;
  poster?: string;
}

/** A series' details and episodes, by season. */
export interface SeriesDetails {
  plot?: string;
  cast?: string;
  genre?: string;
  seasons: { season: number; episodes: Episode[] }[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
const number = (value: unknown) => {
  const n = typeof value === "number" ? value : Number.parseFloat(text(value));
  return Number.isFinite(n) ? n : undefined;
};
const yearOf = (value: unknown) => {
  const match = text(value).match(/\b(19|20)\d\d\b/);
  return match ? Number(match[0]) : undefined;
};

// --- From M3U playlists ---

const VIDEO_FILE = /\.(mp4|mkv|avi|mov|m4v|wmv|flv|webm|mpg|mpeg)$/i;
const PROVIDER_PATH = /\/(movie|movies|series)\/(?:[^/]+\/[^/]+\/)?(\d+)(?:\.\w+)?$/i;
const EPISODE = /^(.*?)[\s\-_.:|]*\bS(\d{1,2})\s*E(\d{1,3})\b[\s\-_.:|]*(.*)$/i;
const CATEGORY_PREFIX = /^(movies?|films?|vod|series|tv shows?)\s*[:|\-–]\s*/i;

const pathOf = (url: string) => {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
};

/** Whether an M3U entry is a film or an episode rather than a channel, and which. */
export const vodKind = (channel: Pick<PlaylistChannel, "url" | "name">): "film" | "episode" | undefined => {
  const path = pathOf(channel.url);
  const provider = path.match(PROVIDER_PATH);
  if (provider) return provider[1].toLowerCase() === "series" ? "episode" : "film";
  if (!VIDEO_FILE.test(path)) return undefined;
  return EPISODE.test(channel.name) ? "episode" : "film";
};

/** "Show S01 E02 Title" as its series, season, episode and title. */
export const parseEpisodeName = (name: string) => {
  const match = name.match(EPISODE);
  if (!match) return undefined;
  return {
    series: match[1].trim() || name,
    season: Number(match[2]),
    episode: Number(match[3]),
    title: match[4].trim(),
  };
};

const category = (group: string | undefined) => group?.replace(CATEGORY_PREFIX, "").trim() || undefined;
const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
/** The provider's id from an Xtream-style URL, or the URL's own query, such as ?movie=12. */
const providerIdOf = (url: string) =>
  pathOf(url).match(PROVIDER_PATH)?.[2] ?? url.match(/[?&](?:movie|series|id)=(\d+)/)?.[1];

/** Gathers an M3U playlist's films and episodes as they're parsed. */
export class M3uVod {
  films: Film[] = [];
  private series = new Map<string, Series>();
  private seen = new Set<string>();

  /** Takes the entry if it's a film or an episode; returns whether it did. */
  add(channel: PlaylistChannel) {
    const kind = vodKind(channel);
    if (!kind) return false;
    const providerId = providerIdOf(channel.url);
    const episode = kind === "episode" ? parseEpisodeName(channel.name) : undefined;
    if (!episode) {
      const id = `m:${providerId ?? nameKey(channel.name)}`;
      if (this.seen.has(id)) return true;
      this.seen.add(id);
      const film: Film = { id, name: channel.name, url: channel.url };
      if (channel.logo) film.poster = channel.logo;
      const group = category(channel.group);
      if (group) film.category = group;
      if (channel.headers) film.headers = channel.headers;
      const year = yearOf(channel.name);
      if (year) film.year = year;
      if (providerId) film.providerId = providerId;
      this.films.push(film);
      return true;
    }
    const key = nameKey(episode.series);
    let show = this.series.get(key);
    if (!show) {
      show = { id: `s:${key}`, name: episode.series, episodes: [] };
      if (channel.logo) show.poster = channel.logo;
      const group = category(channel.group);
      if (group) show.category = group;
      this.series.set(key, show);
    }
    const id = `e:${providerId ?? `${key}:${episode.season}:${episode.episode}`}`;
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    const item: Episode = {
      id,
      season: episode.season,
      episode: episode.episode,
      title: episode.title,
      url: channel.url,
    };
    if (channel.headers) item.headers = channel.headers;
    show.episodes?.push(item);
    return true;
  }

  get count() {
    return this.films.length + this.series.size;
  }

  /** The series, each with its episodes in order. */
  allSeries(): Series[] {
    return Array.from(this.series.values(), show => ({
      ...show,
      // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
      episodes: (show.episodes ?? []).slice().sort((a, b) => a.season - b.season || a.episode - b.episode),
    }));
  }
}

// --- From Xtream accounts ---

const getJson = async (fetcher: typeof fetch, url: string): Promise<unknown> => {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Xtream server answered HTTP ${response.status}`);
  return response.json();
};

const categories = (value: unknown) => {
  const names = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const one of value) if (isObject(one)) names.set(text(one.category_id), text(one.category_name));
  }
  return names;
};

const vodUrl = (login: XtreamLogin, kind: "movie" | "series", id: string, extension: string) => {
  const path = [login.username, login.password].map(encodeURIComponent).join("/");
  return `${normalizeServer(login.server)}/${kind}/${path}/${id}.${extension || "mp4"}`;
};

/** An Xtream account's films and series, as lists. */
export const xtreamVod = async (login: XtreamLogin, fetcher: typeof fetch) => {
  const [filmGroups, films, seriesGroups, series] = await Promise.all([
    getJson(fetcher, playerApiUrl(login, "get_vod_categories")),
    getJson(fetcher, playerApiUrl(login, "get_vod_streams")),
    getJson(fetcher, playerApiUrl(login, "get_series_categories")),
    getJson(fetcher, playerApiUrl(login, "get_series")),
  ]);
  const filmCategory = categories(filmGroups);
  const seriesCategory = categories(seriesGroups);
  const result: { films: Film[]; series: Series[] } = { films: [], series: [] };
  if (Array.isArray(films)) {
    for (const one of films) {
      if (!isObject(one)) continue;
      const id = text(one.stream_id);
      const name = text(one.name);
      if (!id || !name) continue;
      const film: Film = {
        id: `m:${id}`,
        name,
        url: vodUrl(login, "movie", id, text(one.container_extension)),
        providerId: id,
      };
      const poster = text(one.stream_icon);
      if (poster) film.poster = poster;
      const group = filmCategory.get(text(one.category_id));
      if (group) film.category = group;
      const rating = number(one.rating);
      if (rating) film.rating = rating;
      const year = yearOf(one.year) ?? yearOf(name);
      if (year) film.year = year;
      const added = number(one.added);
      if (added) film.added = added * 1000;
      result.films.push(film);
    }
  }
  if (Array.isArray(series)) {
    for (const one of series) {
      if (!isObject(one)) continue;
      const id = text(one.series_id);
      const name = text(one.name);
      if (!id || !name) continue;
      const show: Series = { id: `s:${id}`, name, providerId: id };
      const poster = text(one.cover);
      if (poster) show.poster = poster;
      const group = seriesCategory.get(text(one.category_id));
      if (group) show.category = group;
      const rating = number(one.rating);
      if (rating) show.rating = rating;
      const year = yearOf(one.releaseDate) ?? yearOf(one.release_date);
      if (year) show.year = year;
      const plot = text(one.plot);
      if (plot) show.plot = plot;
      result.series.push(show);
    }
  }
  return result;
};

const durationOf = (info: Json) => {
  const seconds = number(info.duration_secs);
  if (seconds) return seconds * 1000;
  const match = text(info.duration).match(/^(\d+):(\d\d):(\d\d)$/);
  return match ? (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 : undefined;
};

/** A film's details from an Xtream account. */
export const xtreamFilmInfo = async (
  login: XtreamLogin,
  providerId: string,
  fetcher: typeof fetch = fetch,
): Promise<FilmDetails> => {
  const reply = await getJson(
    fetcher,
    `${playerApiUrl(login, "get_vod_info")}&vod_id=${encodeURIComponent(providerId)}`,
  );
  const info = isObject(reply) && isObject(reply.info) ? reply.info : {};
  const details: FilmDetails = {};
  for (const [key, from] of [
    ["plot", "plot"],
    ["cast", "cast"],
    ["director", "director"],
    ["genre", "genre"],
  ] as const) {
    const value = text(info[from]);
    if (value) details[key] = value;
  }
  const durationMs = durationOf(info);
  if (durationMs) details.durationMs = durationMs;
  const year = yearOf(info.releasedate) ?? yearOf(info.release_date);
  if (year) details.year = year;
  const poster = text(info.movie_image) || text(info.cover_big);
  if (poster) details.poster = poster;
  return details;
};

/** A series' details and episodes from an Xtream account. */
export const xtreamSeriesInfo = async (
  login: XtreamLogin,
  providerId: string,
  fetcher: typeof fetch = fetch,
): Promise<SeriesDetails> => {
  const reply = await getJson(
    fetcher,
    `${playerApiUrl(login, "get_series_info")}&series_id=${encodeURIComponent(providerId)}`,
  );
  const root = isObject(reply) ? reply : {};
  const info = isObject(root.info) ? root.info : {};
  const details: SeriesDetails = { seasons: [] };
  for (const key of ["plot", "cast", "genre"] as const) {
    const value = text(info[key]);
    if (value) details[key] = value;
  }
  // { "1": [...], "2": [...] }, or on some servers a list of lists.
  const groups = isObject(root.episodes) ? Object.values(root.episodes) : [];
  const bySeason = new Map<number, Episode[]>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const one of group) {
      if (!isObject(one)) continue;
      const id = text(one.id);
      if (!id) continue;
      const season = number(one.season) ?? 1;
      const episodeInfo = isObject(one.info) ? one.info : {};
      const episode: Episode = {
        id: `e:${id}`,
        season,
        episode: number(one.episode_num) ?? 0,
        title: text(one.title),
        url: vodUrl(login, "series", id, text(one.container_extension)),
      };
      const plot = text(episodeInfo.plot);
      if (plot) episode.plot = plot;
      const durationMs = durationOf(episodeInfo);
      if (durationMs) episode.durationMs = durationMs;
      let list = bySeason.get(season);
      if (!list) bySeason.set(season, (list = []));
      list.push(episode);
    }
  }
  const numbers = [...bySeason.keys()];
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
  numbers.sort((a, b) => a - b);
  details.seasons = numbers
    .map(season => [season, bySeason.get(season) ?? []] as const)
    .map(([season, episodes]) => ({
      season,
      // oxlint-disable-next-line unicorn/no-array-sort -- the list built above
      episodes: episodes.sort((a, b) => a.episode - b.episode),
    }));
  return details;
};

/** An M3U series' episodes, by season. */
export const seasonsOf = (episodes: readonly Episode[]): SeriesDetails["seasons"] => {
  const bySeason = new Map<number, Episode[]>();
  for (const episode of episodes) {
    let list = bySeason.get(episode.season);
    if (!list) bySeason.set(episode.season, (list = []));
    list.push(episode);
  }
  const numbers = [...bySeason.keys()];
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
  numbers.sort((a, b) => a - b);
  return numbers.map(season => ({ season, episodes: bySeason.get(season) ?? [] }));
};

/** "S01 E02" */
export const episodeCode = (episode: Pick<Episode, "season" | "episode">) =>
  `S${String(episode.season).padStart(2, "0")} E${String(episode.episode).padStart(2, "0")}`;

/**
 * An Xtream episode's title often repeats the series and code, as in "Show -
 * S01 E02 - Title"; this keeps the title.
 */
export const episodeTitle = (episode: Pick<Episode, "title" | "season" | "episode">) => {
  const parsed = parseEpisodeName(episode.title);
  return (parsed ? parsed.title.replace(/^[-–:|\s]+/, "") : episode.title).trim();
};
