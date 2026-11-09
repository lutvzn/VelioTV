// Packs programmes into guide blocks (db.ts, guideCodec.ts) and writes them
// in large batches, keeping the guide within a storage budget.
//
// Blocks: each day has its own run of blocks, and each guide channel a place
// in the guide's order, given when its first programme comes. A day's open
// block packs each channel's day as soon as the guide moves on to another
// channel, and closes once it is over BLOCK_BYTES packed, so the import holds
// little more than the open blocks' compressed bytes. Guides list each
// channel's programmes together; a channel that comes back later goes to the
// block that holds its place, merged into it if that block is closed.
//
// Details: only the days around today keep the programmes' subtitles and
// descriptions, which are most of a guide's size; the other days keep
// titles, times and episodes. A refresh brings each day's details as it
// comes near.
//
// The past: each channel's programmes are kept from a time of its own
// (`keepFrom`), as far back as its catch-up reaches, which for most
// channels is only today (importer.ts).
//
// Generations: the writer writes a new generation beside the last import's.
// commit() switches the guide's index to it and deletes the others;
// abandon() deletes it instead. If the browser reports its quota is full,
// `makeRoom` deletes the last generation early, and the batch is written
// again; if that fails too, storing stops.
//
// The budget: the TV allows each app only 80 MB. When the guide grows past
// the budget, a day goes: whichever of the first and last is farther from
// today, counting a day before today as a little farther than the day as
// far after it. Today is kept longest. If even today doesn't fit, the writer
// keeps as many of its blocks as fit, and stops storing.
//
// Guides give each channel's days together, so by the time the budget runs
// out, the first channels' later days would already be packed and stored
// for nothing. To avoid that, once a few hundred channel-days are packed,
// the writer predicts each day's size from them and the number of channels
// the guide lists (`expectedChannels`), and drops days early.
//
// One batch is written while the next is parsed: flush() waits only for the
// batch before. IndexedDB runs transactions on the same store in order, so a
// merge always sees the earlier batch.

import {
  blockAt,
  DAY,
  deleteOtherGenerations,
  finished,
  generationRange,
  isQuotaError,
  writeTransaction,
  type GuideBlock,
  type GuideIndex,
  type GuideMeta,
} from "./db";
import {
  BlockEncoder,
  decodeBlock,
  encodeBlock,
  tidy,
  type PackedBlock,
  type StoredProgramme,
  type Unfinished,
} from "./guideCodec";
import type { Programme } from "./types";

/** Programmes in closed blocks held before writing them. */
const BATCH = 20_000;
/**
 * Packed bytes at which a block closes. It ends up a little bigger, as the
 * encoder counts its output late, and over 64 KB (see db.ts).
 */
export const BLOCK_BYTES = 80 * 1024;
/** Roughly what each record costs besides its data: keys and bookkeeping. */
export const RECORD_OVERHEAD = 64;
/** A guess at a programme's packed size, until a merged block is packed. */
const PROGRAMME_GUESS = 32;
/** Channel-days packed before predicting the guide's size from them. */
const PREDICT_AFTER = 300;
/** Days before and after today that keep subtitles and descriptions. */
export const DETAIL_DAYS = 1;

interface OpenBlock {
  block: number;
  encoder: BlockEncoder;
  channels: Set<string>;
  /** The channel whose programmes are coming now. */
  current?: { channel: string; programmes: Unfinished[] };
}

interface Closed extends PackedBlock {
  day: number;
  block: number;
  channels: number;
  count: number;
}

/** Programmes for blocks already closed. */
interface Late {
  day: number;
  block: number;
  programmes: Map<string, Unfinished[]>;
}

interface Stored {
  day: number;
  block: number;
  bytes: number;
  count: number;
  channels: number;
}

export interface GuideWriterOptions {
  /** The guide's key (db.ts). */
  guide: string;
  /** The generation to write; see the top of this file. */
  generation: number;
  /** Days since 1970 (UTC). */
  today: number;
  /** Days to store. */
  firstDay: number;
  lastDay: number;
  budgetBytes: number;
  /**
   * The time a channel's programmes are kept from: those that end by then
   * are left out. All are kept without it.
   */
  keepFrom?: (channel: string) => number | undefined;
  /** Deletes the last import's guide to make room; resolves whether it deleted anything. */
  makeRoom?: () => Promise<boolean>;
}

const keyOf = (day: number, block: number) => `${day}\n${block}`;

const packedBytes = (block: PackedBlock) => block.data.length + (block.details?.length ?? 0);

const sizeOf = (block: Closed): Stored => ({
  day: block.day,
  block: block.block,
  bytes: packedBytes(block) + RECORD_OVERHEAD,
  count: block.count,
  channels: block.channels,
});

export class GuideWriter {
  /** Programmes given to add(). */
  added = 0;
  /** Programmes left out: outside the days kept, or after storing stopped. */
  skipped = 0;
  /** The days still kept; they narrow to stay within the budget. */
  firstDay: number;
  lastDay: number;
  trimmed = false;
  /** Set when storing has stopped; see the top of this file. */
  stopped: "budget" | "quota" | undefined;
  /** The last batch's write, for probes. */
  writeState = "none";
  /** How many guide channels the guide lists, for predicting its size. */
  expectedChannels = 0;
  /** Time spent waiting for writes, and merging inside them, in ms (ImportTiming). */
  storageWaitMs = 0;
  mergeMs = 0;

  private db: IDBDatabase;
  private options: GuideWriterOptions;
  /** Guide channels in the guide's order, and their places. */
  private order: string[] = [];
  private positions = new Map<string, number>();
  /** Each day's blocks' first places (GuideIndex.days). */
  private starts = new Map<number, number[]>();
  /** Each day's last place in any block. */
  private lastPlace = new Map<number, number>();
  private open = new Map<number, OpenBlock>();
  private closed: Closed[] = [];
  private late = new Map<string, Late>();
  private pendingCount = 0;
  /** Days with programmes added, for the budget. */
  private seen = new Set<number>();
  /** Each stored block, by keyOf(). */
  private stored = new Map<string, Stored>();
  private bytesByDay = new Map<number, number>();
  private channelsByDay = new Map<number, number>();
  /** Stored blocks of days dropped since the last write. */
  private dropped: Stored[] = [];
  private madeRoom = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(db: IDBDatabase, options: GuideWriterOptions) {
    this.db = db;
    this.options = options;
    this.firstDay = options.firstDay;
    this.lastDay = options.lastDay;
  }

  /** Whether enough programmes are waiting that flush() should be called. */
  get full() {
    return this.pendingCount >= BATCH;
  }

  get bytes() {
    let total = 0;
    for (const bytes of this.bytesByDay.values()) total += bytes;
    return total;
  }

  get programmes() {
    let total = 0;
    for (const record of this.stored.values()) total += record.count;
    return total;
  }

  /** The first and last days with programmes stored, which may be inside the days kept. */
  get storedDays() {
    const days = [...this.bytesByDay.keys()];
    return days.length > 0 ? { first: Math.min(...days), last: Math.max(...days) } : undefined;
  }

  /** Blocks stored. */
  get blocks() {
    return this.stored.size;
  }

  add(programme: Programme) {
    this.added++;
    const day = Math.floor(programme.start / DAY);
    if (this.stopped || day < this.firstDay || day > this.lastDay || this.tooOld(programme)) {
      this.skipped++;
      return;
    }
    this.seen.add(day);
    const { channel, start, stop, title, episode, subTitle, description } = programme;
    // Only what is stored, so the XML it came from can go.
    const slim: Unfinished = { start, title };
    if (stop !== undefined) slim.stop = stop;
    if (episode !== undefined) slim.episode = episode;
    if (this.details(day)) {
      if (subTitle !== undefined) slim.subTitle = subTitle;
      if (description !== undefined) slim.description = description;
    }

    let open = this.open.get(day);
    if (open?.current?.channel === channel) {
      open.current.programmes.push(slim);
      return;
    }
    let position = this.positions.get(channel);
    if (position === undefined) {
      position = this.order.length;
      this.order.push(channel);
      this.positions.set(channel, position);
    }
    let starts = this.starts.get(day);
    if (!starts) this.starts.set(day, (starts = []));
    // A place the day's blocks already reach belongs to the block that holds
    // it; a channel before the first block's start moves that start back.
    const newPlace = position > (this.lastPlace.get(day) ?? -1);
    const block = newPlace ? undefined : blockAt(starts, position);
    if (!newPlace && position < starts[0]) starts[0] = position;
    if (block !== undefined && block !== open?.block) {
      this.addLate(day, block, channel, slim);
      return;
    }
    if (open) {
      this.packCurrent(open);
      if (newPlace && open.encoder.bytes >= BLOCK_BYTES) {
        this.close(day);
        open = undefined;
      }
    }
    if (!open) {
      open = { block: starts.length, encoder: new BlockEncoder(day, this.details(day)), channels: new Set() };
      starts.push(position);
      this.open.set(day, open);
    }
    if (newPlace) this.lastPlace.set(day, position);
    open.channels.add(channel);
    open.current = { channel, programmes: [slim] };
  }

  /** Starts writing the closed blocks, once the previous batch is written. */
  async flush() {
    await this.settle();
    this.write();
  }

  /** Closes the open blocks, writes everything, and waits until it is stored. */
  async finish() {
    for (const day of this.open.keys()) this.close(day);
    await this.flush();
    await this.settle();
  }

  /** Makes what was written the guide, with its record, deleting the last import's. */
  async commit(meta: GuideMeta) {
    const run = async () => {
      const transaction = writeTransaction(this.db, ["guide", "guideIndex", "guides"]);
      transaction.objectStore("guideIndex").put(this.index());
      transaction.objectStore("guides").put(meta);
      deleteOtherGenerations(transaction.objectStore("guide"), this.options.guide, this.options.generation);
      await finished(transaction);
    };
    await this.retryWhenFull(run);
  }

  /** Deletes what was written, after a failed import. */
  async abandon() {
    await this.writing.catch(() => {});
    const transaction = writeTransaction(this.db, "guide");
    transaction.objectStore("guide").delete(generationRange(this.options.guide, this.options.generation));
    await finished(transaction);
  }

  /** The guide index for what is stored. */
  index(): GuideIndex {
    const days: Record<number, number[]> = {};
    for (const [day, starts] of this.starts) {
      if (day >= this.firstDay && day <= this.lastDay && starts.length > 0) days[day] = starts;
    }
    return {
      guide: this.options.guide,
      generation: this.options.generation,
      channels: this.order,
      days,
    };
  }

  private details(day: number) {
    return Math.abs(day - this.options.today) <= DETAIL_DAYS;
  }

  // Whether a programme ends before its channel's programmes are kept from.
  // One with no stop time is judged once tidy() has given it one.
  private tooOld(programme: Programme) {
    const from = this.options.keepFrom?.(programme.channel);
    if (from === undefined) return false;
    return (programme.stop ?? programme.start + DAY) <= from;
  }

  // A channel's day, tidied, without what ends before it is kept from.
  private kept(channel: string, programmes: Unfinished[]): StoredProgramme[] {
    const list = tidy(programmes);
    const from = this.options.keepFrom?.(channel);
    return from === undefined ? list : list.filter(p => p.stop > from);
  }

  private addLate(day: number, block: number, channel: string, programme: Unfinished) {
    const key = keyOf(day, block);
    let late = this.late.get(key);
    if (!late) this.late.set(key, (late = { day, block, programmes: new Map() }));
    const list = late.programmes.get(channel);
    if (list) list.push(programme);
    else late.programmes.set(channel, [programme]);
    this.pendingCount++;
  }

  private packCurrent(open: OpenBlock) {
    if (!open.current) return;
    const { channel, programmes } = open.current;
    const list = this.kept(channel, programmes);
    this.skipped += programmes.length - list.length;
    if (list.length > 0) open.encoder.add(channel, list);
    open.current = undefined;
  }

  private close(day: number) {
    const open = this.open.get(day);
    if (!open) return;
    this.packCurrent(open);
    this.open.delete(day);
    const { encoder } = open;
    this.closed.push({
      day,
      block: open.block,
      ...encoder.finish(),
      channels: open.channels.size,
      count: encoder.programmes,
    });
    this.pendingCount += encoder.programmes;
  }

  // Merges programmes into a packed block.
  private merge(day: number, packed: PackedBlock | undefined, extra: Map<string, Unfinished[]>) {
    const channels = packed
      ? decodeBlock(day, packed.data, packed.details)
      : new Map<string, StoredProgramme[]>();
    for (const [channel, programmes] of extra) {
      const list = this.kept(channel, [...(channels.get(channel) ?? []), ...programmes]);
      if (list.length > 0) channels.set(channel, list);
    }
    let count = 0;
    for (const programmes of channels.values()) count += programmes.length;
    const merged: PackedBlock & { channels: number; count: number } = {
      ...encodeBlock(day, channels, this.details(day)),
      channels: channels.size,
      count,
    };
    return merged;
  }

  private write() {
    const closed = this.closed;
    const late = [...this.late.values()];
    this.closed = [];
    this.late = new Map();
    this.pendingCount = 0;
    if (this.stopped || (closed.length === 0 && late.length === 0 && this.dropped.length === 0)) return;

    // Late programmes for blocks in this batch are merged now; for stored
    // ones, in the transaction.
    const inBatch = new Map(closed.map(block => [keyOf(block.day, block.block), block]));
    const toMerge: Late[] = [];
    for (const extra of late) {
      const block = inBatch.get(keyOf(extra.day, extra.block));
      if (block) Object.assign(block, this.merge(block.day, block, extra.programmes));
      else toMerge.push(extra);
    }
    // A merge's size is known only in the transaction; until then, count
    // the old block plus a guess for the new programmes.
    const guessOf = (extra: Late): Stored => {
      const old = this.stored.get(keyOf(extra.day, extra.block));
      let count = 0;
      for (const programmes of extra.programmes.values()) count += programmes.length;
      return {
        day: extra.day,
        block: extra.block,
        bytes: (old?.bytes ?? RECORD_OVERHEAD) + count * PROGRAMME_GUESS,
        count: (old?.count ?? 0) + count,
        channels: (old?.channels ?? 0) + extra.programmes.size,
      };
    };
    const before = {
      stored: new Map(this.stored),
      bytesByDay: new Map(this.bytesByDay),
      channelsByDay: new Map(this.channelsByDay),
    };
    for (const block of closed) this.account(sizeOf(block));
    for (const extra of toMerge) this.account(guessOf(extra));
    this.predict();
    this.trim();
    // With storing stopped, only the blocks of this batch that still fit.
    let fits: Set<string> | undefined;
    if (this.stopped) {
      // Not even today fits: keep as much of it as the budget holds, in the
      // guide's order, and no more.
      this.stored = before.stored;
      this.bytesByDay = before.bytesByDay;
      this.channelsByDay = before.channelsByDay;
      this.forgetOutside();
      fits = new Set();
      for (const block of closed) {
        if (block.day < this.firstDay || block.day > this.lastDay) continue;
        const size = sizeOf(block);
        if (this.bytes + size.bytes > this.options.budgetBytes) break;
        this.account(size);
        fits.add(keyOf(block.day, block.block));
      }
    }
    const kept = (day: number, key: string) =>
      day >= this.firstDay && day <= this.lastDay && (!fits || fits.has(key));
    const dropped = this.dropped;
    this.dropped = [];

    const { guide, generation } = this.options;
    const run = async () => {
      const transaction = writeTransaction(this.db, "guide");
      const store = transaction.objectStore("guide");
      for (const { day, block } of dropped) store.delete([guide, generation, day, block]);
      for (const block of closed) {
        if (!kept(block.day, keyOf(block.day, block.block))) continue;
        const value: GuideBlock = { guide, generation, ...block };
        store.put(value);
      }
      for (const extra of fits ? [] : toMerge) {
        const { day, block } = extra;
        if (!kept(day, keyOf(day, block))) continue;
        const request = store.get([guide, generation, day, block]);
        request.addEventListener("success", () => {
          const old: GuideBlock | undefined = request.result;
          const from = performance.now();
          const merged = this.merge(day, old, extra.programmes);
          this.mergeMs += performance.now() - from;
          const { channels, count } = merged;
          this.account({ day, block, bytes: packedBytes(merged) + RECORD_OVERHEAD, channels, count });
          const value: GuideBlock = { guide, generation, day, block, ...merged };
          store.put(value);
        });
      }
      await finished(transaction);
    };
    this.writeState = "pending";
    this.writing = (async () => {
      try {
        await this.retryWhenFull(run);
        this.writeState = "done";
      } catch (error) {
        this.writeState = `failed: ${error instanceof Error ? error.name : String(error)}`;
        throw error;
      }
    })();
    // Caught here so a failure isn't reported as unhandled; the next flush()
    // or finish() still sees it.
    this.writing.catch(() => {});
  }

  // Runs a write; if storage is full, makes room once and runs it again.
  private async retryWhenFull(run: () => Promise<void>) {
    try {
      await run();
    } catch (error) {
      if (!isQuotaError(error) || this.madeRoom || !this.options.makeRoom) throw error;
      this.madeRoom = true;
      if (!(await this.options.makeRoom())) throw error;
      await run();
    }
  }

  // Waits for the batch being written. Full storage stops storing; any other
  // error ends the import.
  private async settle() {
    const from = performance.now();
    try {
      await this.writing;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      this.stop("quota");
    } finally {
      this.writing = Promise.resolve();
      this.storageWaitMs += performance.now() - from;
    }
  }

  private account(record: Stored) {
    const key = keyOf(record.day, record.block);
    const old = this.stored.get(key);
    if (old) this.addToDay(old, -1);
    this.stored.set(key, record);
    this.addToDay(record, 1);
  }

  private addToDay(record: Stored, sign: number) {
    const { day } = record;
    this.bytesByDay.set(day, (this.bytesByDay.get(day) ?? 0) + sign * record.bytes);
    this.channelsByDay.set(day, (this.channelsByDay.get(day) ?? 0) + sign * record.channels);
  }

  // Drops days that the guide, predicted from what is packed so far, won't
  // have room for.
  private predict() {
    if (this.expectedChannels === 0) return;
    // Each day's packed bytes and channels, open blocks included.
    const days = new Map<number, { bytes: number; channels: number }>();
    for (const [day, bytes] of this.bytesByDay) {
      days.set(day, { bytes, channels: this.channelsByDay.get(day) ?? 0 });
    }
    for (const [day, open] of this.open) {
      const known = days.get(day) ?? { bytes: 0, channels: 0 };
      days.set(day, {
        bytes: known.bytes + open.encoder.bytes,
        channels: known.channels + open.channels.size,
      });
    }
    let channelDays = 0;
    for (const { channels } of days.values()) channelDays += channels;
    if (channelDays < PREDICT_AFTER) return;
    const predicted = () => {
      let total = 0;
      for (const [day, { bytes, channels }] of days) {
        if (day >= this.firstDay && day <= this.lastDay && channels > 0) {
          total += (bytes / channels) * this.expectedChannels;
        }
      }
      return total;
    };
    // No margin: if the prediction is low, trim() still keeps the budget.
    while (predicted() > this.options.budgetBytes && this.dropDay()) {
      // dropDay() narrowed the days.
    }
  }

  // Drops days until the guide fits the budget.
  private trim() {
    while (this.bytes > this.options.budgetBytes) {
      if (!this.dropDay()) {
        // Not even one day fits: write() keeps what fits, and stops.
        this.stop("budget");
        break;
      }
    }
  }

  // Drops the day farthest from today, of those with programmes; false if
  // only one is left.
  private dropDay() {
    let first = Infinity;
    let last = -Infinity;
    for (const day of this.seen) {
      if (day < this.firstDay || day > this.lastDay) continue;
      first = Math.min(first, day);
      last = Math.max(last, day);
    }
    if (!(first < last)) return false;
    const { today } = this.options;
    // Today 0, yesterday 1, tomorrow 2, the day before 3, and so on.
    const rank = (day: number) => (day >= today ? (day - today) * 2 : (today - day) * 2 - 1);
    if (rank(last) >= rank(first)) this.lastDay = last - 1;
    else this.firstDay = first + 1;
    this.trimmed = true;
    this.forgetOutside();
    return true;
  }

  // Forgets everything of the days no longer kept, and keeps their stored
  // blocks to delete.
  private forgetOutside() {
    const outside = (day: number) => day < this.firstDay || day > this.lastDay;
    for (const [key, record] of this.stored) {
      if (!outside(record.day)) continue;
      this.stored.delete(key);
      this.dropped.push(record);
    }
    for (const map of [this.bytesByDay, this.channelsByDay, this.open, this.starts, this.lastPlace]) {
      for (const day of map.keys()) if (outside(day)) map.delete(day);
    }
    this.closed = this.closed.filter(block => !outside(block.day));
    for (const [key, extra] of this.late) if (outside(extra.day)) this.late.delete(key);
  }

  private stop(reason: "budget" | "quota") {
    this.stopped ??= reason;
    this.trimmed = true;
  }
}
