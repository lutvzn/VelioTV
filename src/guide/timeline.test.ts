import { describe, expect, it } from "vitest";
import type { StoredProgramme } from "../data/guideCodec";
import {
  alignDown,
  cellAt,
  mergeDays,
  nextAnchor,
  placeCell,
  previousAnchor,
  rowCells,
  spanStart,
  wholeRow,
} from "./timeline";

const MIN = 60_000;
const HOUR = 60 * MIN;
const STEP = 30 * MIN;
const SPAN = 2 * HOUR;
// A local midnight, so half hours fall where the TV shows them.
const base = new Date(2026, 10, 7).getTime();
const at = (hours: number) => base + hours * HOUR;
const show = (title: string, start: number, stop: number): StoredProgramme => ({
  title,
  start: at(start),
  stop: at(stop),
});

describe("guide rows", () => {
  it("aligns times to half hours of local time", () => {
    expect(alignDown(at(14) + 10 * MIN, STEP)).toBe(at(14));
    expect(alignDown(at(14) + 40 * MIN, STEP)).toBe(at(14.5));
    expect(alignDown(at(14), STEP)).toBe(at(14));
  });

  it("merges days, keeping a programme that crosses midnight once", () => {
    const first = [show("Late", 22, 24), show("Overnight", 23.5, 25)];
    const second = [show("Overnight", 23.5, 25), show("Early", 25, 26)];
    expect(mergeDays([first, second]).map(p => p.title)).toEqual(["Late", "Overnight", "Early"]);
    expect(mergeDays([first])).toBe(first);
  });

  it("fills the gaps between programmes, and keeps their own times at the ends", () => {
    const programmes = [show("Old", 10, 11), show("A", 13, 14.5), show("B", 15, 16), show("C", 16, 18)];
    const cells = rowCells(programmes, at(14), at(17));
    expect(cells.map(c => [c.kind, c.programme?.title, c.start, c.stop])).toEqual([
      ["programme", "A", at(13), at(14.5)],
      ["gap", undefined, at(14.5), at(15)],
      ["programme", "B", at(15), at(16)],
      ["programme", "C", at(16), at(18)],
    ]);
  });

  it("starts and ends with gaps where the guide has nothing", () => {
    const cells = rowCells([show("A", 15, 16)], at(14), at(17));
    expect(cells.map(c => c.kind)).toEqual(["gap", "programme", "gap"]);
    expect(cells[0]).toMatchObject({ start: at(14), stop: at(15) });
    expect(cells[2]).toMatchObject({ start: at(16), stop: at(17) });
    expect(rowCells([], at(14), at(17))).toEqual([{ kind: "gap", start: at(14), stop: at(17) }]);
  });

  it("cuts a programme that overlaps the one before", () => {
    const cells = rowCells([show("A", 14, 15), show("B", 14.5, 16)], at(14), at(17));
    expect(cells[1]).toMatchObject({ kind: "programme", start: at(15), stop: at(16) });
  });

  it("splits a row with no programmes into steps", () => {
    const cells = wholeRow("none", at(14) + 10 * MIN, at(15), STEP);
    expect(cells.map(c => c.start)).toEqual([at(14), at(14.5)]);
    expect(cells.every(c => c.kind === "none")).toBe(true);
  });

  it("finds the cell on at a moment", () => {
    const cells = rowCells([show("A", 14, 15), show("B", 15, 16)], at(13), at(17));
    expect(cellAt(cells, at(14.5))?.programme?.title).toBe("A");
    expect(cellAt(cells, at(15))?.programme?.title).toBe("B");
    expect(cellAt(cells, at(20))).toBe(cells[cells.length - 1]);
  });

  it("moves the focus to the next and previous cells", () => {
    const cells = rowCells([show("A", 13.5, 15), show("B", 15, 16), show("C", 16, 18)], at(12), at(19));
    // Right: the start of the next cell, until the last moment the guide goes to.
    expect(nextAnchor(cells, at(14.2), at(30))).toBe(at(15));
    expect(nextAnchor(cells, at(16.5), at(18))).toBeUndefined();
    // Left: the start of the cell before, no earlier than the earliest time.
    expect(previousAnchor(cells, at(16.5), at(14), STEP)).toBe(at(15));
    expect(previousAnchor(cells, at(15.2), at(14), STEP)).toBe(at(14));
    // The programme on now is the first one: Left leaves the guide.
    expect(previousAnchor(cells, at(14.2), at(14), STEP)).toBeUndefined();
    // Before the first cell known, a step back.
    const steps = wholeRow("loading", at(15), at(17), STEP);
    expect(previousAnchor(steps, at(15), at(14), STEP)).toBe(at(14.5));
  });

  it("moves the span in steps to keep the focus in view", () => {
    expect(spanStart(at(14.5), at(14), SPAN, STEP, at(14))).toBe(at(14));
    // The last half hour shown moves the span on.
    expect(spanStart(at(15.6), at(14), SPAN, STEP, at(14))).toBe(at(14.5));
    expect(spanStart(at(20), at(14), SPAN, STEP, at(14))).toBe(at(19));
    expect(spanStart(at(14.2), at(15), SPAN, STEP, at(14))).toBe(at(14));
    expect(spanStart(at(13), at(15), SPAN, STEP, at(14))).toBe(at(14));
  });

  it("places cells in pixels, cut to the span", () => {
    const px = 1200 / SPAN;
    expect(placeCell({ kind: "gap", start: at(13), stop: at(14.5) }, at(14), at(16), px)).toEqual({
      x: 0,
      width: 300,
    });
    expect(placeCell({ kind: "gap", start: at(15.5), stop: at(18) }, at(14), at(16), px)).toEqual({
      x: 900,
      width: 300,
    });
  });
});
