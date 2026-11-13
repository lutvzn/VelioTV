// What the player page gets for an add-on's film or episode (PLAN.md,
// "Stremio add-ons", step 5): the stream chosen from the add-ons' streams,
// its subtitles and every add-on's subtitle files, and for an episode the
// next one, played from the same add-on's stream of the same kind.

import type { Stream } from "#devices/common/player";
import type { Episode, SeriesDetails } from "../data/vod";
import type { FilmEntry, SeriesEntry } from "../data/vodLibrary";
import { addons } from "../library";
import type { AddonStream } from "../stremio/addon";
import type { FoundStreams } from "../stremio/addons";
import type { ExternalSubtitle, VodPlay } from "./session";
import { allEpisodes, episodePlay, filmPlay } from "./vodPlay";

/** A stream picked, with the add-on it came from. */
export interface ChosenStream {
  addon: string;
  addonName: string;
  stream: AddonStream;
}

/**
 * Every playable stream found, in order, with its add-on; those whose sound
 * the TV may not play (DTS or TrueHD) after the rest.
 */
export const chosenStreams = (found: FoundStreams[]): ChosenStream[] => {
  const all = found.flatMap(one =>
    one.streams.map(stream => ({ addon: one.addon, addonName: one.addonName, stream })),
  );
  return [...all.filter(one => !one.stream.silent), ...all.filter(one => one.stream.silent)];
};

/**
 * How long an add-on's stream may take to show its first picture: a debrid
 * add-on's link may first have to be fetched by the debrid service (PLAN.md,
 * "Debrid add-ons").
 */
export const ADDON_START_TIMEOUT_MS = 45_000;

export const streamOf = (chosen: ChosenStream): Stream => ({
  url: chosen.stream.url,
  ...(chosen.stream.userAgent ? { userAgent: chosen.stream.userAgent } : {}),
  startTimeoutMs: ADDON_START_TIMEOUT_MS,
  from: chosen.addonName,
  redirects: true,
});

/** The stream's own subtitles (if it's an add-on's), then every add-on's, each address once. */
export const subtitlesFor = (type: "movie" | "series", id: string, chosen?: ChosenStream) => async () => {
  const own: ExternalSubtitle[] = (chosen?.stream.subtitles ?? []).map(subtitle => ({
    ...subtitle,
    from: chosen?.addonName ?? "",
  }));
  const others = await addons.subtitles(type, id).catch(() => []);
  const seen = new Set(own.map(subtitle => subtitle.url));
  const more: ExternalSubtitle[] = [];
  for (const subtitle of others) {
    if (seen.has(subtitle.url)) continue;
    seen.add(subtitle.url);
    more.push({ id: subtitle.id, url: subtitle.url, language: subtitle.language, from: subtitle.addonName });
  }
  return [...own, ...more];
};

export const addonFilmPlay = (
  film: FilmEntry,
  chosen: ChosenStream,
  startMs?: number,
): Omit<VodPlay, "kind"> => ({
  ...filmPlay(film, startMs),
  stream: streamOf(chosen),
  ...(film.stremio ? { subtitles: subtitlesFor("movie", film.stremio.id, chosen) } : {}),
});

/**
 * The stream for the next episode that's most like the last: the same
 * binge group, else the same add-on's first, else the first of any.
 */
export const likeLast = (found: ChosenStream[], last: ChosenStream) =>
  (last.stream.bingeGroup
    ? found.find(one => one.addon === last.addon && one.stream.bingeGroup === last.stream.bingeGroup)
    : undefined) ??
  found.find(one => one.addon === last.addon) ??
  found[0];

export const addonEpisodePlay = (
  show: SeriesEntry,
  details: SeriesDetails,
  episode: Episode,
  chosen: ChosenStream,
  startMs?: number,
): Omit<VodPlay, "kind"> => {
  const list = allEpisodes(details);
  const following = list[list.findIndex(one => one.id === episode.id) + 1];
  const next = following?.stremio
    ? async (): Promise<VodPlay | undefined> => {
        const found = chosenStreams(await addons.streams("series", following.stremio ?? ""));
        const stream = likeLast(found, chosen);
        return stream ? { kind: "vod", ...addonEpisodePlay(show, details, following, stream) } : undefined;
      }
    : undefined;
  return {
    ...episodePlay(show, details, episode, startMs),
    stream: streamOf(chosen),
    next,
    ...(episode.stremio ? { subtitles: subtitlesFor("series", episode.stremio, chosen) } : {}),
  };
};
