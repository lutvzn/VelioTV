// What the player page gets for an add-on's film or episode (PLAN.md,
// "Stremio add-ons", step 5): the stream chosen from the add-ons' streams,
// its subtitles and every add-on's subtitle files, and for an episode the
// next one, played from the same add-on's stream of the same kind.
//
// The next episode's stream is found by its file's name when the add-on
// gives no binge group, and an episode still to come isn't played next
// (after NuvioTVSmart's filenameEpisodeMatcher.js and
// playerNextEpisodeRules.js, https://github.com/NuvioMedia/NuvioTVSmart,
// GPL-3.0; changed: rewritten in TypeScript).

import type { Stream } from "#devices/common/player";
import type { PlayChoices, StreamOrder } from "../data/playChoices";
import type { Episode, SeriesDetails } from "../data/vod";
import type { FilmEntry, SeriesEntry } from "../data/vodLibrary";
import { addons, playChoices } from "../library";
import type { AddonStream } from "../stremio/addon";
import type { FoundStreams } from "../stremio/addons";
import { nextFileName, sameFileName } from "../stremio/episodeFile";
import { autoPlayable } from "./autoPlay";
import type { ExternalSubtitle, VodPlay } from "./session";
import { episodeLabel, episodePlay, filmPlay, nextEpisode } from "./vodPlay";

/** A stream picked, with the add-on it came from. */
export interface ChosenStream {
  addon: string;
  addonName: string;
  stream: AddonStream;
}

/** An add-on's streams with the best picture first, then the biggest file, else in the add-on's order. */
const byQuality = (streams: AddonStream[]) =>
  streams
    .map((stream, at) => ({ stream, at }))
    // With the place as the tie-break, as older TVs' sort isn't stable.
    // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
    .sort(
      (one, other) =>
        (other.stream.height ?? 0) - (one.stream.height ?? 0) ||
        (other.stream.sizeBytes ?? 0) - (one.stream.sizeBytes ?? 0) ||
        one.at - other.at,
    )
    .map(one => one.stream);

/**
 * Every playable stream found, in order, with its add-on; those whose sound
 * the TV may not play (DTS or TrueHD) after the rest. With `order`
 * "quality", each add-on's best picture comes first.
 */
export const chosenStreams = (
  found: FoundStreams[],
  order: StreamOrder = playChoices.choices().order,
): ChosenStream[] => {
  const all = found.flatMap(one =>
    (order === "quality" ? byQuality(one.streams) : one.streams).map(stream => ({
      addon: one.addon,
      addonName: one.addonName,
      stream,
    })),
  );
  return [...all.filter(one => !one.stream.silent), ...all.filter(one => one.stream.silent)];
};

/**
 * How long an add-on's stream may take to show its first picture: a debrid
 * add-on's link may first have to be fetched by the debrid service (PLAN.md,
 * "Debrid add-ons").
 */
export const ADDON_START_TIMEOUT_MS = 45_000;

/**
 * A stream's add-on, name, description and file name, as one line for
 * auto-play's pattern: add-ons break their names over lines ("[TB+]
 * Torrentio\n720p"), and a pattern is typed on one.
 */
export const streamText = (chosen: ChosenStream) =>
  [chosen.addonName, chosen.stream.name, chosen.stream.description, chosen.stream.filename ?? ""]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The streams auto-play would try after `chosen` if it doesn't start, by
 * the profile's choices; none with auto-play off.
 */
export const fallbackStreams = (found: ChosenStream[], chosen: ChosenStream, choices: PlayChoices) =>
  autoPlayable(
    found
      .filter(one => one.stream.url !== chosen.stream.url)
      .map(one => ({ choice: one, text: streamText(one), settled: true })),
    choices,
  )
    .slice(0, choices.fallbacks)
    .map(one => one.choice);

export const streamOf = (chosen: ChosenStream, startTimeoutMs = ADDON_START_TIMEOUT_MS): Stream => ({
  url: chosen.stream.url,
  ...(chosen.stream.userAgent ? { userAgent: chosen.stream.userAgent } : {}),
  startTimeoutMs,
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
  fromAddon: chosen,
  ...(film.stremio ? { subtitles: subtitlesFor("movie", film.stremio.id, chosen) } : {}),
});

/**
 * The stream for the next episode that's most like the last: the file of
 * the same name but the next episode's number, else the same binge group,
 * else the same add-on's first, else the first of any.
 */
export const likeLast = (found: ChosenStream[], last: ChosenStream, next?: Episode) => {
  const wanted =
    next && last.stream.filename ? nextFileName(last.stream.filename, next.season, next.episode) : undefined;
  return (
    (wanted ? found.find(one => sameFileName(one.stream.filename, wanted)) : undefined) ??
    (last.stream.bingeGroup
      ? found.find(one => one.addon === last.addon && one.stream.bingeGroup === last.stream.bingeGroup)
      : undefined) ??
    found.find(one => one.addon === last.addon) ??
    found[0]
  );
};

export const addonEpisodePlay = (
  show: SeriesEntry,
  details: SeriesDetails,
  episode: Episode,
  chosen: ChosenStream,
  startMs?: number,
): Omit<VodPlay, "kind"> => {
  const following = nextEpisode(details, episode);
  const next = following?.stremio
    ? async (): Promise<VodPlay | undefined> => {
        const found = chosenStreams(await addons.streams("series", following.stremio ?? ""));
        const stream = likeLast(found, chosen, following);
        if (!stream) return undefined;
        const others = fallbackStreams(found, stream, playChoices.choices());
        return {
          kind: "vod",
          ...addonEpisodePlay(show, details, following, stream),
          ...(others.length > 0
            ? {
                fallbacks: () =>
                  Promise.resolve(
                    others.map(one => ({
                      kind: "vod" as const,
                      ...addonEpisodePlay(show, details, following, one),
                    })),
                  ),
              }
            : {}),
        };
      }
    : undefined;
  return {
    ...episodePlay(show, details, episode, startMs),
    stream: streamOf(chosen),
    fromAddon: chosen,
    next,
    nextTitle: following?.stremio ? episodeLabel(following) : undefined,
    ...(episode.stremio ? { subtitles: subtitlesFor("series", episode.stremio, chosen) } : {}),
  };
};
