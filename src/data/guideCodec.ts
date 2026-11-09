// Packs a run of guide channels' programmes for one day into a compressed
// block (PLAN.md, Phase 8, step 2). The TV allows each app only 80 MB of
// storage, and on a real guide this takes a programme from about 284 bytes
// of XMLTV to about 30 (with details) or 7 (without).
//
// A block has two parts, each a JSON array deflated with fflate:
//   grid     a row per channel: [channel, starts, lengths, titles, episodes]
//   details  a row for each grid row: [subTitles, descriptions]
// Times are seconds: the first start from the start of the day, each one
// after from the end of the programme before (so mostly 0). A column is 0
// when no programme has it. The guide grid unpacks only the first part,
// about a fifth of the bytes, and the details unpack when a programme is
// focused; on a real guide the two parts together came out 2% smaller than
// one (PLAN.md, Phase 8, step 2). Blocks of days far from today have no
// details part (guideWriter.ts).
//
// fflate is synchronous and works on TVs without CompressionStream;
// BlockEncoder packs a block as its rows come, so the import holds no more
// than a channel's day of programmes. Only what the app shows is kept: not
// the programmes' icons, categories or "new" flags.

import { Deflate, inflateSync, strFromU8, strToU8 } from "fflate";
import type { Programme } from "./types";

export const DAY = 86_400_000;
const HOUR = 3_600_000;
const LEVEL = 6;

/** A programme as stored: its channel and day are in the record's key. */
export type StoredProgramme = Pick<Programme, "start" | "title" | "episode" | "subTitle" | "description"> & {
  stop: number;
};

/** A programme as read, before tidy() fills in its stop time. */
export type Unfinished = Omit<StoredProgramme, "stop"> & { stop?: number };

/** What a programme's details part holds. */
export type ProgrammeDetails = Pick<Programme, "subTitle" | "description">;

/** A block as packed: the grid, and the details if the day keeps them. */
export interface PackedBlock {
  data: Uint8Array;
  details?: Uint8Array;
}

type Column = (string | null)[] | 0;
type GridRow = [string, number[], number[], string[], Column];
type DetailsRow = [Column, Column];

/**
 * Sorts a channel's day of programmes, drops repeats of the same start time
 * (keeping the later one), and fills in missing stop times from the next
 * programme.
 */
//
// The workers run code lowered to ES5 on every TV, where spreads and for...of
// become slow helpers, so this and gridRow() copy and loop by hand: a spread
// here took a third of a guide's packing on the TV.
export const tidy = (programmes: Unfinished[]): StoredProgramme[] => {
  // Not toSorted(): older TVs' browsers lack it, and workers get no polyfills.
  // oxlint-disable-next-line unicorn/prefer-spread
  const sorted = programmes.slice();
  // oxlint-disable-next-line unicorn/no-array-sort
  sorted.sort((a, b) => a.start - b.start);
  const list: StoredProgramme[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const next = sorted[i + 1];
    if (next && next.start === p.start) continue;
    const kept: StoredProgramme = {
      start: p.start,
      title: p.title,
      stop: p.stop ?? (next ? next.start : p.start + HOUR),
    };
    if (p.episode !== undefined) kept.episode = p.episode;
    if (p.subTitle !== undefined) kept.subTitle = p.subTitle;
    if (p.description !== undefined) kept.description = p.description;
    list.push(kept);
  }
  return list;
};

const column = (programmes: StoredProgramme[], field: "episode" | "subTitle" | "description"): Column =>
  programmes.some(p => p[field] !== undefined) ? programmes.map(p => p[field] ?? null) : 0;

/** A channel's day of programmes (tidied, in start order) as a grid row. */
const gridRow = (day: number, channel: string, programmes: StoredProgramme[]): GridRow => {
  const starts: number[] = [];
  const lengths: number[] = [];
  let previous = day * DAY;
  // oxlint-disable-next-line unicorn/no-for-loop
  for (let i = 0; i < programmes.length; i++) {
    const p = programmes[i];
    starts.push(Math.round((p.start - previous) / 1000));
    lengths.push(Math.round((p.stop - p.start) / 1000));
    previous = p.stop;
  }
  return [channel, starts, lengths, programmes.map(p => p.title), column(programmes, "episode")];
};

/** One part of a block, packed as its rows come. */
class Part {
  bytes = 0;
  private rows = 0;
  private chunks: Uint8Array[] = [];
  private deflate = new Deflate({ level: LEVEL }, chunk => {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  });

  add(row: unknown) {
    const text = JSON.stringify(row);
    this.deflate.push(strToU8(this.rows === 0 ? `[${text}` : `,${text}`));
    this.rows++;
  }

  finish(): Uint8Array {
    this.deflate.push(strToU8(this.rows === 0 ? "[]" : "]"), true);
    const data = new Uint8Array(this.bytes);
    let at = 0;
    for (const chunk of this.chunks) {
      data.set(chunk, at);
      at += chunk.length;
    }
    this.chunks = [];
    return data;
  }
}

/** Packs a block as its rows come. */
export class BlockEncoder {
  rows = 0;
  programmes = 0;
  private grid = new Part();
  private details: Part | undefined;
  private day: number;

  /** With `details`, the block keeps subtitles and descriptions. */
  constructor(day: number, details: boolean) {
    this.day = day;
    if (details) this.details = new Part();
  }

  /** Compressed bytes so far; the last row's may not be counted yet. */
  get bytes() {
    return this.grid.bytes + (this.details?.bytes ?? 0);
  }

  /** Adds a channel's day; a channel added twice is merged when read. */
  add(channel: string, programmes: StoredProgramme[]) {
    this.grid.add(gridRow(this.day, channel, programmes));
    this.details?.add([column(programmes, "subTitle"), column(programmes, "description")]);
    this.rows++;
    this.programmes += programmes.length;
  }

  finish(): PackedBlock {
    const packed: PackedBlock = { data: this.grid.finish() };
    if (this.details) packed.details = this.details.finish();
    return packed;
  }
}

/** Packs a whole block at once. */
export const encodeBlock = (
  day: number,
  channels: Iterable<[string, StoredProgramme[]]>,
  details: boolean,
): PackedBlock => {
  const encoder = new BlockEncoder(day, details);
  for (const [channel, programmes] of channels) encoder.add(channel, programmes);
  return encoder.finish();
};

// The parts were written by BlockEncoder.
const unpack = <T>(data: Uint8Array): T[] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  JSON.parse(strFromU8(inflateSync(data))) as T[];

/**
 * A block's programmes by channel, in start order: with subtitles and
 * descriptions if `details` (the block's second part) is given.
 */
export const decodeBlock = (
  day: number,
  data: Uint8Array,
  details?: Uint8Array,
): Map<string, StoredProgramme[]> => {
  const rows = unpack<GridRow>(data);
  const extra = details ? unpack<DetailsRow>(details) : [];
  const channels = new Map<string, StoredProgramme[]>();
  const merge = new Set<string>();
  rows.forEach(([channel, starts, lengths, titles, episodes], row) => {
    const [subTitles, descriptions] = extra[row] ?? [0, 0];
    const programmes: StoredProgramme[] = [];
    let previous = day * DAY;
    for (let i = 0; i < starts.length; i++) {
      const start = previous + starts[i] * 1000;
      const programme: StoredProgramme = { start, stop: start + lengths[i] * 1000, title: titles[i] };
      const episode = episodes === 0 ? null : episodes[i];
      const subTitle = subTitles === 0 ? null : subTitles[i];
      const description = descriptions === 0 ? null : descriptions[i];
      if (episode !== null) programme.episode = episode;
      if (subTitle !== null) programme.subTitle = subTitle;
      if (description !== null) programme.description = description;
      programmes.push(programme);
      previous = programme.stop;
    }
    const earlier = channels.get(channel);
    if (earlier) {
      earlier.push(...programmes);
      merge.add(channel);
    } else channels.set(channel, programmes);
  });
  // A channel whose day came in parts.
  for (const channel of merge) channels.set(channel, tidy(channels.get(channel) ?? []));
  return channels;
};
