// Playing a modern layout's title (PLAN.md, "Movies and Series by title",
// step 5) from the link picked: a source's copy or an add-on's
// stream. Where it was left is kept under the title's key, whichever link
// played. Subtitle files from add-ons are offered for either, when the
// title has an IMDb id, and the next episode keeps to the same source.

import type { Episode, EpisodeLink, SeriesDetails } from "../data/vod";
import type { FilmEntry, SeriesEntry } from "../data/vodLibrary";
import { addons } from "../library";
import { chosenStreams, likeLast, streamOf, subtitlesFor, type ChosenStream } from "./addonPlay";
import type { VodPlay } from "./session";
import { allEpisodes, episodeItem, filmItem } from "./vodPlay";

/** What's picked: one of the title's copies from the TV's sources, or an add-on's stream. */
export type TitleChoice<L> = { kind: "source"; link: L } | { kind: "addon"; chosen: ChosenStream };

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

/** The next episode's link most like the last: the same source, or the same add-on's kind of stream. */
const nextChoice = async (
  episode: Episode,
  last: TitleChoice<EpisodeLink>,
): Promise<TitleChoice<EpisodeLink> | undefined> => {
  const links = episode.links ?? [];
  if (last.kind === "source") {
    const same = links.find(link => link.show.source === last.link.show.source);
    if (same) return { kind: "source", link: same };
  }
  if (episode.stremio) {
    const found = chosenStreams(await addons.streams("series", episode.stremio).catch(() => []));
    const like = last.kind === "addon" ? likeLast(found, last.chosen) : undefined;
    if (like) return { kind: "addon", chosen: like };
    if (links[0]) return { kind: "source", link: links[0] };
    if (found[0]) return { kind: "addon", chosen: found[0] };
    return undefined;
  }
  return links[0] ? { kind: "source", link: links[0] } : undefined;
};

export const titleEpisodePlay = (
  title: SeriesEntry,
  details: SeriesDetails,
  episode: Episode,
  choice: TitleChoice<EpisodeLink>,
  startMs?: number,
): Omit<VodPlay, "kind"> => {
  const list = allEpisodes(details);
  const following = list[list.findIndex(one => one.id === episode.id) + 1];
  return {
    item: episodeItem(title, episode),
    stream: choice.kind === "source" ? linkStream(choice.link.episode) : streamOf(choice.chosen),
    startMs: startMs || undefined,
    back: "/series",
    next: following
      ? async () => {
          const next = await nextChoice(following, choice);
          return next ? { kind: "vod", ...titleEpisodePlay(title, details, following, next) } : undefined;
        }
      : undefined,
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
