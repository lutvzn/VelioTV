// Packs a run of guide channels' programmes for one day into a compressed
// block (PLAN.md, Phase 8, step 2). The TV allows each app only 80 MB of
// storage, and on a real guide this takes a programme from about 284 bytes
// of XMLTV to about 30 (with details) or 7 (without).
//
// A block is a JSON array with a row per channel, deflated with fflate:
//   [channel, starts, lengths, titles, episodes, subTitles, descriptions]
// Times are seconds: the first start from the start of the day, each one
// after from the end of the programme before (so mostly 0). The last three
// columns are 0 when no programme has them. fflate is synchronous and works
// on TVs without CompressionStream; BlockEncoder packs a block as its rows
// come, so the import holds no more than a channel's day of programmes.
//
// Only what the app shows is kept: not the programmes' icons, categories or
// "new" flags. Blocks of days far from today leave out the subtitles and
// descriptions (guideWriter.ts).

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

type Column = (string | null)[] | 0;
type Row = [string, number[], number[], string[], Column, Column, Column];

/**
 * Sorts a channel's day of programmes, drops repeats of the same start time
 * (keeping the later one), and fills in missing stop times from the next
 * programme.
 */
export const tidy = (programmes: Unfinished[]): StoredProgramme[] => {
  // Not toSorted(): older TVs' browsers lack it, and workers get no polyfills.
  const sorted = [...programmes];
  // oxlint-disable-next-line unicorn/no-array-sort
  sorted.sort((a, b) => a.start - b.start);
  const list: StoredProgramme[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const next = sorted[i + 1];
    if (next && next.start === p.start) continue;
    list.push({ ...p, stop: p.stop ?? (next ? next.start : p.start + HOUR) });
  }
  return list;
};

const column = (programmes: StoredProgramme[], field: "episode" | "subTitle" | "description"): Column =>
  programmes.some(p => p[field] !== undefined) ? programmes.map(p => p[field] ?? null) : 0;

/** A channel's day of programmes (tidied, in start order) as a block's row. */
const rowOf = (day: number, channel: string, programmes: StoredProgramme[], details: boolean): Row => {
  const starts: number[] = [];
  const lengths: number[] = [];
  let previous = day * DAY;
  for (const p of programmes) {
    starts.push(Math.round((p.start - previous) / 1000));
    lengths.push(Math.round((p.stop - p.start) / 1000));
    previous = p.stop;
  }
  return [
    channel,
    starts,
    lengths,
    programmes.map(p => p.title),
    column(programmes, "episode"),
    details ? column(programmes, "subTitle") : 0,
    details ? column(programmes, "description") : 0,
  ];
};

/** Packs a block as its rows come. */
export class BlockEncoder {
  /** Compressed bytes so far; the last row's may not be counted yet. */
  bytes = 0;
  rows = 0;
  programmes = 0;
  private chunks: Uint8Array[] = [];
  private deflate = new Deflate({ level: LEVEL }, chunk => {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  });
  private day: number;
  private details: boolean;

  constructor(day: number, details: boolean) {
    this.day = day;
    this.details = details;
  }

  /** Adds a channel's day; a channel added twice is merged when read. */
  add(channel: string, programmes: StoredProgramme[]) {
    const row = JSON.stringify(rowOf(this.day, channel, programmes, this.details));
    this.deflate.push(strToU8(this.rows === 0 ? `[${row}` : `,${row}`));
    this.rows++;
    this.programmes += programmes.length;
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

/** Packs a whole block at once. */
export const encodeBlock = (
  day: number,
  channels: Iterable<[string, StoredProgramme[]]>,
  details: boolean,
): Uint8Array => {
  const encoder = new BlockEncoder(day, details);
  for (const [channel, programmes] of channels) encoder.add(channel, programmes);
  return encoder.finish();
};

/** A block's programmes by channel, in start order. */
export const decodeBlock = (day: number, data: Uint8Array): Map<string, StoredProgramme[]> => {
  // The block was written by BlockEncoder.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const rows = JSON.parse(strFromU8(inflateSync(data))) as Row[];
  const channels = new Map<string, StoredProgramme[]>();
  const merge = new Set<string>();
  for (const [channel, starts, lengths, titles, episodes, subTitles, descriptions] of rows) {
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
  }
  // A channel whose day came in parts.
  for (const channel of merge) channels.set(channel, tidy(channels.get(channel) ?? []));
  return channels;
};
