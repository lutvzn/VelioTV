// Which stream plays without the picker (PLAN.md, "Auto-play"): the first,
// or the first whose text matches the profile's pattern and has none of
// its excluded words, and after it the ones tried if it doesn't start.
//
// Adapted from NuvioTVSmart (https://github.com/NuvioMedia/NuvioTVSmart,
// GPL-3.0): js/core/streams/streamAutoPlaySelector.js and
// js/core/player/sourceFallback.js. Changed: rewritten in TypeScript; the
// excluded words are a field of their own as well as read from a pattern's
// "(?!.*(CAM|TS))".

import type { PlayChoices } from "../data/playChoices";

/** Text the user typed as a pattern: a regular expression, or else the words as they are. */
const patternOf = (text: string) => {
  try {
    return new RegExp(text, "i");
  } catch {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
};

/** The words a pattern's "(?!.*(A|B))" leaves out, with the excluded field's. */
export const excludedWords = (pattern: string, exclude: string) => {
  const words: string[] = [];
  const lookahead = /\(\?![^)]*?\(([^)]+)\)/g;
  for (let match = lookahead.exec(pattern); match; match = lookahead.exec(pattern))
    words.push(...(match[1] ?? "").split("|"));
  words.push(...exclude.split(/[|,]/));
  return words.map(word => word.trim()).filter(Boolean);
};

/** Whether a stream's text is one the pattern auto-plays. */
export const createMatcher = (choices: Pick<PlayChoices, "pattern" | "exclude">) => {
  const pattern = choices.pattern.trim();
  const include = /[a-z0-9]/i.test(pattern) ? patternOf(pattern) : undefined;
  const words = excludedWords(pattern, choices.exclude).map(word =>
    word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const leaveOut = words.length > 0 ? new RegExp(`\\b(${words.join("|")})\\b`, "i") : undefined;
  return (text: string) => (!include || include.test(text)) && !leaveOut?.test(text);
};

/** A row the picker could play, and whether what's before it in the list is all known. */
export interface Candidate<C> {
  choice: C;
  /** The add-on's name, the stream's name and description, as one text. */
  text: string;
  /** Nothing still to come could be listed before it. */
  settled: boolean;
}

/**
 * The rows auto-play would play, in order: every row for "first", the
 * matching ones for "pattern", none when it's off.
 */
export const autoPlayable = <C>(
  rows: Candidate<C>[],
  choices: Pick<PlayChoices, "autoPlay" | "pattern" | "exclude">,
): Candidate<C>[] => {
  if (choices.autoPlay === "off") return [];
  if (choices.autoPlay === "first") return rows;
  const matches = createMatcher(choices);
  return rows.filter(row => matches(row.text));
};

/**
 * The row to play now: the first auto-playable one, once nothing could
 * still come before it. Undefined while it's not known yet, or if none is.
 */
export const autoPick = <C>(
  rows: Candidate<C>[],
  choices: Pick<PlayChoices, "autoPlay" | "pattern" | "exclude">,
) => {
  const [first] = autoPlayable(rows, choices);
  return first?.settled ? first : undefined;
};
