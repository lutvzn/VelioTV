// How a film or episode's end is judged (PLAN.md, "Auto-play"): whether it
// really finished, so it counts as watched and the next episode plays, and
// when the next episode's card shows.
//
// A debrid add-on gives a short clip in place of a file it doesn't have yet
// ("downloading", "not available"), which plays to its end in seconds.
// Counted as a finish, it would mark the episode watched and run through
// the season one clip after another.
//
// Adapted from NuvioTVSmart (https://github.com/NuvioMedia/NuvioTVSmart,
// GPL-3.0): js/core/player/naturalPlaybackCompletion.js, and the
// next-episode card's threshold from its player settings. Changed:
// rewritten in TypeScript; the card's threshold as a share or as seconds
// before the end.

import type { NextCard } from "../data/playChoices";

/** Streams up to 2:01 long are taken for placeholder or error clips. */
export const SHORT_CLIP_MS = 120_999;

export const isShortClip = (durationMs: number) =>
  Number.isFinite(durationMs) && durationMs >= 1 && durationMs <= SHORT_CLIP_MS;

/** Whether reaching the end counts as watching it to the end. */
export const finishedNaturally = (end: { showedPicture: boolean; failed: boolean; durationMs: number }) =>
  !end.failed && end.showedPicture && !isShortClip(end.durationMs);

/** Whether the next episode's card shows at `positionMs` of `durationMs`. */
export const nextCardShown = (card: NextCard, positionMs: number, durationMs: number) => {
  if (card === "off" || !(durationMs > 0) || isShortClip(durationMs)) return false;
  if (card.endsWith("%")) return positionMs >= (durationMs * Number(card.slice(0, -1))) / 100;
  return positionMs >= durationMs - Number(card.slice(0, -1)) * 1000;
};
