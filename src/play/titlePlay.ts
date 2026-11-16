// Playing a modern layout's title (PLAN.md, "Movies and Series by title",
// step 5) from the link picked: a source's copy or an add-on's
// stream. Where it was left is kept under the title's key, whichever link
// played. Subtitle files from add-ons are offered for either, when the
// title has an IMDb id, and the next episode keeps to the same source.

import type { Episode, EpisodeLink, SeriesDetails } from "../data/vod";
import type { FilmEntry, SeriesEntry } from "../data/vodLibrary";
import { addons, playChoices } from "../library";
import {
  chosenStreams,
  fallbackStreams,
  likeLast,
  streamOf,
  subtitlesFor,
  type ChosenStream,
} from "./addonPlay";
import type { VodPlay } from "./session";
import { episodeItem, episodeLabel, filmItem, nextEpisode } from "./vodPlay";

/** What's picked: one of the title's copies from the TV's sources, or an add-on's stream. */
export type TitleChoice<L> = { kind: "source"; link: L } | { kind: "addon"; chosen: ChosenStream };

/** Picked without a key, by auto-play (src/pages/vod/StreamPicker.tsx): what it would try next. */
export interface AutoPicked<L> {
  others: () => Promise<TitleChoice<L>[]>;
}

/** `play`, with the links auto-play tries if it doesn't start. */
export const withOthers = <L>(
  play: Omit<VodPlay, "kind">,
  auto: AutoPicked<L> | undefined,
  build: (choice: TitleChoice<L>) => Omit<VodPlay, "kind">,
): Omit<VodPlay, "kind"> =>
  auto
    ? {
        ...play,
        fallbacks: async () =>
          (await auto.others()).map(choice => ({ kind: "vod" as const, ...build(choice) })),
      }
    : play;

const linkStream = (link: { url: string; headers?: { userAgent?: string; referer?: string } }) => ({
  url: link.url,
  userAgent: link.headers?.userAgent,
  referer: link.headers?.referer,
});

export const titleFilmPlay = (
  title: FilmEntry,
  choice: TitleChoice<FilmEntry>,
  startMs?: number,
): Omit<VodPlay, "kind"> => ({
  item: filmItem(title),
  stream: choice.kind === "source" ? linkStream(choice.link) : streamOf(choice.chosen),
  ...(choice.kind === "addon" ? { fromAddon: choice.chosen } : {}),
  startMs: startMs || undefined,
  back: "/movies",
  ...(title.stremio
    ? {
        subtitles: subtitlesFor(
          "movie",
          title.stremio.id,
          choice.kind === "addon" ? choice.chosen : undefined,
        ),
      }
    : {}),
});

/**
 * The next episode's link most like the last: the same source, or the same
 * add-on's kind of stream; with the add-on streams to try after it.
 */
const nextChoice = async (
  episode: Episode,
  last: TitleChoice<EpisodeLink>,
): Promise<{ choice: TitleChoice<EpisodeLink>; others: ChosenStream[] } | undefined> => {
  const links = episode.links ?? [];
  if (last.kind === "source") {
    const same = links.find(link => link.show.source === last.link.show.source);
    if (same) return { choice: { kind: "source", link: same }, others: [] };
  }
  if (episode.stremio) {
    const found = chosenStreams(await addons.streams("series", episode.stremio).catch(() => []));
    const like = last.kind === "addon" ? likeLast(found, last.chosen, episode) : undefined;
    if (like)
      return {
        choice: { kind: "addon", chosen: like },
        others: fallbackStreams(found, like, playChoices.choices()),
      };
    if (links[0]) return { choice: { kind: "source", link: links[0] }, others: [] };
    if (found[0])
      return {
        choice: { kind: "addon", chosen: found[0] },
        others: fallbackStreams(found, found[0], playChoices.choices()),
      };
    return undefined;
  }
  return links[0] ? { choice: { kind: "source", link: links[0] }, others: [] } : undefined;
};

export const titleEpisodePlay = (
  title: SeriesEntry,
  details: SeriesDetails,
  episode: Episode,
  choice: TitleChoice<EpisodeLink>,
  startMs?: number,
): Omit<VodPlay, "kind"> => {
  const following = nextEpisode(details, episode);
  return {
    item: episodeItem(title, episode),
    stream: choice.kind === "source" ? linkStream(choice.link.episode) : streamOf(choice.chosen),
    ...(choice.kind === "addon" ? { fromAddon: choice.chosen } : {}),
    startMs: startMs || undefined,
    back: "/series",
    next: following
      ? async () => {
          const next = await nextChoice(following, choice);
          if (!next) return undefined;
          const { others } = next;
          return {
            kind: "vod",
            ...titleEpisodePlay(title, details, following, next.choice),
            ...(others.length > 0
              ? {
                  fallbacks: () =>
                    Promise.resolve(
                      others.map(one => ({
                        kind: "vod" as const,
                        ...titleEpisodePlay(title, details, following, { kind: "addon", chosen: one }),
                      })),
                    ),
                }
              : {}),
          };
        }
      : undefined,
    ...(following && (following.stremio || following.links?.length)
      ? { nextTitle: episodeLabel(following) }
      : {}),
    ...(episode.stremio
      ? {
          subtitles: subtitlesFor(
            "series",
            episode.stremio,
            choice.kind === "addon" ? choice.chosen : undefined,
          ),
        }
      : {}),
  };
};
