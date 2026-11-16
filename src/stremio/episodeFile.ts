// The next episode's file from its name (PLAN.md, "Stremio add-ons"): a
// stream of "Show.S01E03.1080p.mkv" goes on to the one of
// "Show.S01E04.1080p.mkv", from the same pack and release, when the add-on
// gives no binge group.
//
// Adapted from NuvioTVSmart (https://github.com/NuvioMedia/NuvioTVSmart,
// GPL-3.0): js/core/streams/filenameEpisodeMatcher.js. Changed: rewritten in
// TypeScript, with no padStart for older TVs.

const SXE = /([sS])\s*(\d{1,3})\s*([eE])\s*(\d{1,4})/;
const CROSS = /(^|[^0-9])(\d{1,2})([xX])(\d{1,4})/;
const EPISODE_ONLY = /\b([eE][pP]?)([.\s]?)(\d{1,4})\b/;

/** `value` with leading zeros, as wide as `like`. */
const pad = (value: number, like: string) => {
  let text = String(value);
  while (text.length < like.length) text = `0${text}`;
  return text;
};

const replaced = (name: string, match: RegExpExecArray, text: string) =>
  name.slice(0, match.index) + text + name.slice(match.index + match[0].length);

/** The season and episode a file's name gives; the season is undefined for "E03" alone. */
export const seasonEpisodeOf = (name: string) => {
  const match = SXE.exec(name) ?? CROSS.exec(name);
  if (match) return { season: Number(match[2]), episode: Number(match[4]) };
  const single = EPISODE_ONLY.exec(name);
  return single ? { season: undefined, episode: Number(single[3]) } : undefined;
};

/**
 * The name the file of `season` `episode` would have, given this one's:
 * "Show.S01E03.mkv" to "Show.S01E04.mkv". Undefined if the name has no
 * episode in it.
 */
export const nextFileName = (name: string, season: number, episode: number) => {
  const now = seasonEpisodeOf(name);
  if (!now) return undefined;
  for (const pattern of [SXE, CROSS]) {
    const match = pattern.exec(name);
    if (
      match &&
      now.season !== undefined &&
      Number(match[2]) === now.season &&
      Number(match[4]) === now.episode
    ) {
      const [, before = "", seasonText = "", mark = "", episodeText = ""] = match;
      return replaced(name, match, `${before}${pad(season, seasonText)}${mark}${pad(episode, episodeText)}`);
    }
  }
  const match = EPISODE_ONLY.exec(name);
  if (!match || Number(match[3]) !== now.episode) return undefined;
  const [, mark = "", gap = "", episodeText = ""] = match;
  return replaced(name, match, `${mark}${gap}${pad(episode, episodeText)}`);
};

/** Whether two file names are the same, ignoring case. */
export const sameFileName = (one: string | undefined, other: string | undefined) =>
  !!one?.trim() && !!other?.trim() && one.toLowerCase() === other.toLowerCase();
