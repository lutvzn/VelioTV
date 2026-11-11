// The add-ons' titles as the Movies and Series pages' entries (PLAN.md,
// "Stremio add-ons", step 4). They're keyed by their id in Stremio, not by
// the add-on, so where one was left is found from any catalog that has it,
// and Continue watching shows it without the catalog.

import type { Episode, FilmDetails, SeriesDetails } from "../data/vod";
import { seasonsOf } from "../data/vod";
import type { AddonDetails, FilmEntry, SeriesEntry } from "../data/vodLibrary";
import type { WatchedItem } from "../data/watched";
import type { AddonMeta } from "./addon";
import type { Addons } from "./addons";

const PREFIX = "stremio:";

export const filmKey = (id: string) => `${PREFIX}movie:${id}`;
export const seriesKey = (id: string) => `${PREFIX}series:${id}`;
export const episodeKeyOf = (videoId: string) => `${PREFIX}episode:${videoId}`;

/** The Stremio id in a key made by filmKey() or seriesKey(), if it is one. */
export const idInKey = (key: string, type: "movie" | "series") => {
  const start = `${PREFIX}${type}:`;
  return key.startsWith(start) ? key.slice(start.length) : undefined;
};

export const addonFilm = (meta: AddonMeta, addon: string): FilmEntry => {
  const film: FilmEntry = {
    id: `m:${meta.id}`,
    name: meta.name,
    // Streams are asked for when it's played.
    url: "",
    source: addon,
    key: filmKey(meta.id),
    stremio: { type: "movie", id: meta.id },
  };
  if (meta.poster) film.poster = meta.poster;
  if (meta.rating) film.rating = meta.rating;
  if (meta.year) film.year = meta.year;
  if (meta.genres?.[0]) film.category = meta.genres[0];
  return film;
};

export const addonSeries = (meta: AddonMeta, addon: string): SeriesEntry => {
  const show: SeriesEntry = {
    id: `s:${meta.id}`,
    name: meta.name,
    source: addon,
    key: seriesKey(meta.id),
    stremio: { type: "series", id: meta.id },
  };
  if (meta.poster) show.poster = meta.poster;
  if (meta.rating) show.rating = meta.rating;
  if (meta.year) show.year = meta.year;
  if (meta.plot) show.plot = meta.plot;
  if (meta.genres?.[0]) show.category = meta.genres[0];
  return show;
};

/** A film left partway, from what the resume list kept, for Continue watching. */
export const keptFilm = (entry: WatchedItem): FilmEntry | undefined => {
  const id = idInKey(entry.key, "movie");
  if (!id) return undefined;
  return addonFilm({ id, type: "movie", name: entry.title, poster: entry.poster }, "");
};

/** A series being watched, from what the resume list kept of its latest episode. */
export const keptSeries = (entry: WatchedItem): SeriesEntry | undefined => {
  const id = entry.series ? idInKey(entry.series, "series") : undefined;
  if (!id) return undefined;
  return addonSeries({ id, type: "series", name: entry.seriesName ?? entry.title, poster: entry.poster }, "");
};

const genreOf = (meta: AddonMeta) =>
  meta.genres && meta.genres.length > 0 ? meta.genres.join(", ") : undefined;

export const filmDetailsOf = (meta: AddonMeta | undefined): FilmDetails => {
  if (!meta) return {};
  const details: FilmDetails = {};
  if (meta.plot) details.plot = meta.plot;
  if (meta.cast) details.cast = meta.cast;
  if (meta.director) details.director = meta.director;
  const genre = genreOf(meta);
  if (genre) details.genre = genre;
  if (meta.durationMs) details.durationMs = meta.durationMs;
  if (meta.year) details.year = meta.year;
  if (meta.poster) details.poster = meta.poster;
  if (meta.background) details.backdrop = meta.background;
  return details;
};

export const seriesDetailsOf = (meta: AddonMeta | undefined): SeriesDetails => {
  if (!meta) return { seasons: [] };
  const episodes = (meta.videos ?? []).map((video): Episode => ({
    id: `e:${video.id}`,
    stremio: video.id,
    season: video.season,
    episode: video.episode,
    title: video.title,
    url: "",
    ...(video.plot ? { plot: video.plot } : {}),
  }));
  const seasons = seasonsOf(episodes);
  // Season 0 is specials, after the rest.
  const specials = seasons.filter(one => one.season === 0);
  const details: SeriesDetails = { seasons: [...seasons.filter(one => one.season !== 0), ...specials] };
  if (meta.plot) details.plot = meta.plot;
  if (meta.cast) details.cast = meta.cast;
  const genre = genreOf(meta);
  if (genre) details.genre = genre;
  if (meta.background) details.backdrop = meta.background;
  return details;
};

/** A title's details from the add-ons, or else from `fallback` (Cinemeta, src/stremio/cinemeta.ts). */
const metaOf = async (
  addons: Addons,
  fallback: Addons | undefined,
  type: string,
  id: string,
  first?: string,
) =>
  (await addons.meta(type, id, first).catch(() => undefined)) ??
  (fallback ? await fallback.meta(type, id).catch(() => undefined) : undefined);

/** The add-on titles' details, for the VOD library. */
export const addonDetails = (addons: Addons, fallback?: Addons): AddonDetails => ({
  film: film =>
    film.stremio
      ? metaOf(addons, fallback, "movie", film.stremio.id, film.source || undefined).then(filmDetailsOf)
      : Promise.resolve({}),
  series: show =>
    show.stremio
      ? metaOf(addons, fallback, "series", show.stremio.id, show.source || undefined).then(seriesDetailsOf)
      : Promise.resolve({ seasons: [] }),
});
