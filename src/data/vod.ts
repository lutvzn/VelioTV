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

import { sortedCopy } from "./sortedCopy";
import type { PlaylistChannel, StreamHeaders } from "./types";
import { normalizeServer, playerApiUrl, type XtreamLogin } from "./xtream";
import { ensureFetch } from "../polyfills/fetch";

ensureFetch();

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
  /** From a Stremio add-on: its video id, to ask the add-ons for streams (src/stremio/). */
  stremio?: string;
  season: number;
  episode: number;
  title: string;
  url: string;
  headers?: StreamHeaders;
  plot?: string;
  durationMs?: number;
  /**
   * In the modern layout, every source's copy of this episode (PLAN.md,
   * "Movies and Series by title"): each source's series and its episode.
   */
  links?: EpisodeLink[];
}

/** An IPTV source's copy of an episode, for a title that joins several. */
export interface EpisodeLink {
  show: Series & { source: string; key: string };
  episode: Episode;
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
  /** Its id on TMDB, which Xtream lists give, for matching it to Cinemeta (src/data/titleMatches.ts). */
  tmdb?: number;
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
  /** A wide picture from the film, for behind its page. */
  backdrop?: string;
  /** Its id on TMDB. */
  tmdb?: number;
}

/** A series' details and episodes, by season. */
export interface SeriesDetails {
  plot?: string;
  cast?: string;
  genre?: string;
  /** A wide picture from the series, for behind its page. */
  backdrop?: string;
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

// Every entry of a playlist, channels too, is looked at here, so the URL is
// read by hand rather than with regular expressions; vod.test.ts holds them
// to what the expressions they replace gave.
const VIDEO_FILES = new Set(["mp4", "mkv", "avi", "mov", "m4v", "wmv", "flv", "webm", "mpg", "mpeg"]);
const EPISODE = /^(.*?)[\s\-_.:|]*\bS(\d{1,2})\s*E(\d{1,3})\b[\s\-_.:|]*(.*)$/i;
const CATEGORY_PREFIX = /^(movies?|films?|vod|series|tv shows?)\s*[:|\-–]\s*/i;
const QUERY_ID = /[?&](?:movie|series|id)=(\d+)/;

/** Where a URL's path ends: at its query or fragment. */
const pathEnd = (url: string) => {
  const query = url.indexOf("?");
  const hash = url.indexOf("#");
  if (query === -1) return hash === -1 ? url.length : hash;
  return hash === -1 || query < hash ? query : hash;
};

const isDigitCode = (code: number) => code >= 48 && code <= 57;
const isWordCode = (code: number) =>
  isDigitCode(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

// Whether url[from, to) is "movie", "movies" or "series", in any case, and which.
const providerKind = (url: string, from: number, to: number): "film" | "episode" | undefined => {
  const length = to - from;
  if (length !== 5 && length !== 6) return undefined;
  const word = url.slice(from, to).toLowerCase();
  if (word === "series") return "episode";
  return word === "movie" || word === "movies" ? "film" : undefined;
};

/**
 * An Xtream-style film or episode path, ".../movie/<id>.mkv" or
 * ".../series/<user>/<password>/<id>.mp4", with "movie", "movies" or
 * "series" in any case and the extension optional: its kind and id. The one
 * further left wins, as with a search.
 */
const providerPath = (url: string, end: number) => {
  const last = url.lastIndexOf("/", end - 1);
  if (last === -1) return undefined;
  // The last segment: digits, then perhaps "." and word characters.
  let at = last + 1;
  while (at < end && isDigitCode(url.charCodeAt(at))) at++;
  const digitsEnd = at;
  if (digitsEnd === last + 1) return undefined;
  if (at < end) {
    if (url.charCodeAt(at) !== 46 /* . */ || at + 1 === end) return undefined;
    for (at++; at < end; at++) if (!isWordCode(url.charCodeAt(at))) return undefined;
  }
  const id = url.slice(last + 1, digitsEnd);
  // The segments before it, from the right: b/a/<id>.
  const a = last > 0 ? url.lastIndexOf("/", last - 1) : -1;
  const b = a > 0 ? url.lastIndexOf("/", a - 1) : -1;
  const c = b > 0 ? url.lastIndexOf("/", b - 1) : -1;
  // "/kind/x/y/<id>": two non-empty segments between.
  if (c !== -1 && a - b > 1 && last - a > 1) {
    const kind = providerKind(url, c + 1, b);
    if (kind) return { kind, id };
  }
  if (a !== -1) {
    const kind = providerKind(url, a + 1, last);
    if (kind) return { kind, id };
  }
  return undefined;
};

const isVideoFile = (url: string, end: number) => {
  const dot = url.lastIndexOf(".", end - 1);
  if (dot === -1 || end - dot > 5) return false;
  return VIDEO_FILES.has(url.slice(dot + 1, end).toLowerCase());
};

/** An M3U entry's kind, and its provider's id for it if the URL has one. */
const classify = (channel: Pick<PlaylistChannel, "url" | "name">) => {
  const { url } = channel;
  const end = pathEnd(url);
  const provider = providerPath(url, end);
  let kind: "film" | "episode" | undefined = provider?.kind;
  if (!kind) {
    if (!isVideoFile(url, end)) return undefined;
    kind = EPISODE.test(channel.name) ? "episode" : "film";
  }
  return { kind, providerId: provider ? provider.id : QUERY_ID.exec(url)?.[1] };
};

/** Whether an M3U entry is a film or an episode rather than a channel, and which. */
export const vodKind = (channel: Pick<PlaylistChannel, "url" | "name">): "film" | "episode" | undefined =>
  classify(channel)?.kind;

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

/** Gathers an M3U playlist's films and episodes as they're parsed. */
export class M3uVod {
  films: Film[] = [];
  private series = new Map<string, Series>();
  private seen = new Set<string>();

  /** Takes the entry if it's a film or an episode; returns whether it did. */
  add(channel: PlaylistChannel) {
    const found = classify(channel);
    if (!found) return false;
    // The provider's id from an Xtream-style URL, or the URL's own query, such as ?movie=12.
    const { kind, providerId } = found;
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
    // Built by hand, not spread: the worker runs as ES5 (PLAN.md, Phase 8, step 4).
    const list: Series[] = [];
    this.series.forEach(show => {
      const copy: Series = {
        id: show.id,
        name: show.name,
        episodes: sortedCopy(show.episodes ?? [], (a, b) => a.season - b.season || a.episode - b.episode),
      };
      if (show.poster !== undefined) copy.poster = show.poster;
      if (show.category !== undefined) copy.category = show.category;
      list.push(copy);
    });
    return list;
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
      const tmdb = tmdbOf(one.tmdb_id ?? one.tmdb);
      if (tmdb) show.tmdb = tmdb;
      result.series.push(show);
    }
  }
  return result;
};

/** A TMDB id, which Xtream gives as a number or as text; 0 and junk are none. */
const tmdbOf = (value: unknown) => {
  const id = Number(text(value));
  return Number.isInteger(id) && id > 0 ? id : undefined;
};

/** Xtream's `backdrop_path`: a list of addresses, or on some servers one. */
const backdropOf = (info: Json) => {
  const value = info.backdrop_path;
  const first = Array.isArray(value) ? (value as unknown[]).find(one => text(one)) : value;
  return text(first) || undefined;
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
  const backdrop = backdropOf(info);
  if (backdrop) details.backdrop = backdrop;
  const tmdb = tmdbOf(info.tmdb_id ?? info.tmdb);
  if (tmdb) details.tmdb = tmdb;
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
  const backdrop = backdropOf(info);
  if (backdrop) details.backdrop = backdrop;
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
