// Packs a guide channel's programmes for one day into a small compressed
// block. The TV allows each app only 80 MB of storage (PLAN.md, Phase 2), and
// on real guides this takes a programme from about 284 bytes to about 64.
//
// The block is JSON of field arrays, so each field name appears once per day
// instead of once per programme, deflated with fflate. fflate is synchronous
// (merging records inside a transaction needs that) and works on TVs without
// CompressionStream.

import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import type { Programme } from "./types";

export const DAY = 86_400_000;

/** A programme as stored: its channel and day are in the record's key. */
export type StoredProgramme = Omit<Programme, "channel"> & { stop: number };

interface Columns {
  /** Seconds from the start of the day. */
  start: number[];
  /** Seconds long. */
  length: number[];
  title: string[];
  subTitle?: (string | null)[];
  description?: (string | null)[];
  categories?: (string[] | null)[];
  episode?: (string | null)[];
  icon?: (string | null)[];
  isNew?: number[];
}

type Optional = "subTitle" | "description" | "categories" | "episode" | "icon";
const OPTIONAL: Optional[] = ["subTitle", "description", "categories", "episode", "icon"];

export const encodeDay = (day: number, programmes: StoredProgramme[]): Uint8Array => {
  const base = day * DAY;
  const columns: Columns = {
    start: programmes.map(p => Math.round((p.start - base) / 1000)),
    length: programmes.map(p => Math.round((p.stop - p.start) / 1000)),
    title: programmes.map(p => p.title),
  };
  for (const field of OPTIONAL) {
    if (programmes.some(p => p[field] !== undefined)) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      (columns[field] as unknown[]) = programmes.map(p => p[field] ?? null);
    }
  }
  if (programmes.some(p => p.isNew)) columns.isNew = programmes.map(p => (p.isNew ? 1 : 0));
  return deflateSync(strToU8(JSON.stringify(columns)), { level: 1 });
};

export const decodeDay = (day: number, data: Uint8Array): StoredProgramme[] => {
  // The block was written by encodeDay.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const columns = JSON.parse(strFromU8(inflateSync(data))) as Columns;
  const base = day * DAY;
  return columns.start.map((start, i) => {
    const programme: StoredProgramme = {
      start: base + start * 1000,
      stop: base + (start + columns.length[i]) * 1000,
      title: columns.title[i],
    };
    for (const field of OPTIONAL) {
      const value = columns[field]?.[i];
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      if (value != null) (programme[field] as unknown) = value;
    }
    if (columns.isNew?.[i]) programme.isNew = true;
    return programme;
  });
};
