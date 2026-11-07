// The TV guide's rows as cells along a time line (PLAN.md, Phase 4, step 2).
// A row covers a span of time with cells: its programmes, and gaps where the
// guide has nothing, so that every moment of a row can take the focus.
//
// Focus is a row and a moment (the anchor), not a cell: moving up and down
// keeps the moment and lands on whatever is on then, so going through rows
// doesn't drift along the time line. Left and Right move the anchor to the
// cell before or after.

import type { StoredProgramme } from "../data/guideCodec";

export type CellKind = "programme" | "gap" | "loading" | "none";

export interface Cell {
  kind: CellKind;
  start: number;
  stop: number;
  programme?: StoredProgramme;
}

/** `ms` rounded down to a multiple of `step`, in local time as the TV shows it. */
export const alignDown = (ms: number, step: number) => {
  const offset = new Date(ms).getTimezoneOffset() * 60_000;
  return Math.floor((ms - offset) / step) * step + offset;
};

/**
 * Programmes from one or more days, in start order, each once. Days overlap:
 * a day starts with the programme still on from the day before.
 */
export const mergeDays = (days: readonly (readonly StoredProgramme[])[]) => {
  if (days.length === 1) return days[0];
  const seen = new Set<number>();
  const merged: StoredProgramme[] = [];
  for (const day of days) {
    for (const programme of day) {
      if (seen.has(programme.start)) continue;
      seen.add(programme.start);
      merged.push(programme);
    }
  }
  // toSorted() needs Chromium 110; older TVs are still targets.
  // oxlint-disable-next-line unicorn/no-array-sort
  return merged.sort((a, b) => a.start - b.start);
};

/**
 * A row's cells from `from` to `to`. Programmes keep their own times, so the
 * first and last can reach past the span; gaps stop at its ends. Programmes
 * that overlap the one before lose the overlap.
 */
export const rowCells = (programmes: readonly StoredProgramme[], from: number, to: number): Cell[] => {
  const cells: Cell[] = [];
  let at = from;
  for (const programme of programmes) {
    if (programme.stop <= at || programme.stop <= from) continue;
    if (programme.start >= to) break;
    const start = cells.length === 0 ? programme.start : Math.max(programme.start, at);
    if (start > at) cells.push({ kind: "gap", start: at, stop: start });
    cells.push({ kind: "programme", start, stop: programme.stop, programme });
    at = programme.stop;
  }
  if (at < to) cells.push({ kind: "gap", start: at, stop: to });
  return cells;
};

/**
 * A row without programmes, while its guide loads or when it has none, as
 * cells a `step` long, so the focus moves along it as along any other row.
 * The page draws it as one bar.
 */
export const wholeRow = (kind: "loading" | "none", from: number, to: number, step: number): Cell[] => {
  const cells: Cell[] = [];
  for (let start = alignDown(from, step); start < to; start += step) {
    cells.push({ kind, start, stop: start + step });
  }
  return cells;
};

/** The cell on at `at`, or the nearest one at the ends. Cells follow on without gaps. */
export const cellAt = (cells: readonly Cell[], at: number) =>
  cells.find(cell => cell.stop > at) ?? cells[cells.length - 1];

/** The anchor after Right: the start of the next cell, or undefined at `latest`. */
export const nextAnchor = (cells: readonly Cell[], anchor: number, latest: number) => {
  const cell = cellAt(cells, anchor);
  if (!cell || cell.stop >= latest) return undefined;
  return cell.stop;
};

/**
 * The anchor after Left: the start of the cell before, no earlier than
 * `earliest`, or undefined when the focused cell already starts there. Past
 * the first cell known, it moves back a `step`.
 */
export const previousAnchor = (cells: readonly Cell[], anchor: number, earliest: number, step: number) => {
  const cell = cellAt(cells, anchor);
  if (!cell || cell.start <= earliest) return undefined;
  const before = cellAt(cells, cell.start - 1);
  const start = before && before !== cell ? before.start : cell.start - step;
  return Math.max(start, earliest);
};

/**
 * Where the span starts so that `anchor` shows with at least `step` after it,
 * moving in steps from `from` and never before `earliest`.
 */
export const spanStart = (anchor: number, from: number, span: number, step: number, earliest: number) => {
  let start = from;
  while (anchor >= start + span - step) start += step;
  while (anchor < start) start -= step;
  return Math.max(start, earliest);
};

/** A cell's place in a span, in pixels, cut to the span. */
export const placeCell = (cell: Cell, from: number, to: number, pxPerMs: number) => {
  const start = Math.max(cell.start, from);
  const stop = Math.min(cell.stop, to);
  return { x: Math.round((start - from) * pxPerMs), width: Math.round((stop - start) * pxPerMs) };
};
