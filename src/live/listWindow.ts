// Which rows of a long list are drawn. The channel list over the video draws
// a fixed number of rows and fills them from the list as the cursor moves,
// so 10,000 channels cost the same as 12 (PLAN.md, Phase 3, step 3).

/** The first row to draw so `cursor` shows, moving as little as possible from `top`. */
export const scrollTop = (cursor: number, top: number, rows: number, count: number) => {
  const last = Math.max(0, count - rows);
  if (cursor < top) return Math.max(0, Math.min(cursor, last));
  if (cursor >= top + rows) return Math.max(0, Math.min(cursor - rows + 1, last));
  return Math.max(0, Math.min(top, last));
};

/** The first row to draw with `cursor` in the middle, as when the list opens. */
export const centredTop = (cursor: number, rows: number, count: number) =>
  Math.max(0, Math.min(cursor - Math.floor(rows / 2), count - rows));

/** `index` moved by `step`, wrapping round at the ends. */
export const wrapIndex = (index: number, step: number, count: number) =>
  count === 0 ? 0 : (((index + step) % count) + count) % count;

/** `index` moved by `step`, stopping at the ends. */
export const clampIndex = (index: number, step: number, count: number) =>
  Math.max(0, Math.min(index + step, count - 1));
