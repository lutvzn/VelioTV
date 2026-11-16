// What the player page gets for a film or an episode (src/play/session.ts):
// its stream, where to start, and for an episode the one after it.

import type { Episode, SeriesDetails } from "../data/vod";
import { episodeCode, episodeTitle } from "../data/vod";
import type { FilmEntry, SeriesEntry } from "../data/vodLibrary";
import type { Watched, WatchedItem } from "../data/watched";
import type { VodPlay } from "./session";
import { episodeKeyOf } from "../stremio/vodEntries";

export const filmItem = (film: FilmEntry): WatchedItem => ({
  key: film.key,
  kind: "film",
  title: film.name,
  ...(film.poster ? { poster: film.poster } : {}),
});

export const filmPlay = (film: FilmEntry, startMs?: number): Omit<VodPlay, "kind"> => ({
  item: filmItem(film),
  stream: { url: film.url, userAgent: film.headers?.userAgent, referer: film.headers?.referer },
  startMs,
  back: "/movies",
});

/** "<source>/e:<id>", or "stremio:episode:<id>" for an add-on's episode, whichever add-on has it. */
export const episodeKey = (show: SeriesEntry, episode: Episode) =>
  episode.stremio ? episodeKeyOf(episode.stremio) : `${show.source}/${episode.id}`;

/** "S01 E02  Title" */
export const episodeLabel = (episode: Episode) => {
  const title = episodeTitle(episode);
  return title ? `${episodeCode(episode)}  ${title}` : episodeCode(episode);
};

export const episodeItem = (show: SeriesEntry, episode: Episode): WatchedItem => ({
  key: episodeKey(show, episode),
  kind: "episode",
  title: episodeLabel(episode),
  series: show.key,
  seriesName: show.name,
  season: episode.season,
  episode: episode.episode,
  ...(show.poster ? { poster: show.poster } : {}),
});

/** Every episode, in order. */
export const allEpisodes = (details: SeriesDetails) => details.seasons.flatMap(season => season.episodes);

/**
 * Whether an episode has been on: one with no date, or a date that doesn't
 * read, counts as on (after hasEpisodeAired in NuvioTVSmart's
 * playerNextEpisodeRules.js, GPL-3.0, changed).
 */
export const hasAired = (episode: Episode, now = Date.now()) =>
  episode.released === undefined || !Number.isFinite(episode.released) || episode.released <= now;

/**
 * The episode to go on to after `episode`: the next in order, a special
 * only after a special, and none if it hasn't been on yet.
 */
export const nextEpisode = (details: SeriesDetails, episode: Episode, now = Date.now()) => {
  const list = allEpisodes(details);
  const at = list.findIndex(one => one.id === episode.id);
  if (at < 0) return undefined;
  const special = episode.season === 0;
  const following = list.slice(at + 1).find(one => (one.season === 0) === special);
  return following && hasAired(following, now) ? following : undefined;
};

/** An episode to play, going on to the next when it ends. */
export const episodePlay = (
  show: SeriesEntry,
  details: SeriesDetails,
  episode: Episode,
  startMs?: number,
): Omit<VodPlay, "kind"> => {
  const next = nextEpisode(details, episode);
  return {
    item: episodeItem(show, episode),
    stream: { url: episode.url, userAgent: episode.headers?.userAgent, referer: episode.headers?.referer },
    startMs,
    back: "/series",
    next: next ? () => Promise.resolve({ kind: "vod", ...episodePlay(show, details, next) }) : undefined,
    ...(next ? { nextTitle: episodeLabel(next) } : {}),
  };
};

/**
 * The episode to carry on with: the last one watched, unless it was
 * finished, then the one after it; the first if none was watched.
 */
export const episodeToContinue = (show: SeriesEntry, details: SeriesDetails, watched: Watched) => {
  const list = allEpisodes(details);
  const latest = watched.latestEpisodes().find(entry => entry.series === show.key);
  const at = latest ? list.findIndex(episode => episodeKey(show, episode) === latest.key) : -1;
  if (at < 0) return list[0];
  return latest?.finished ? (list[at + 1] ?? list[at]) : list[at];
};
