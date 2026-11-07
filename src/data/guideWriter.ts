// Collects programmes into one record per guide channel per day, compresses
// them, and writes them in large batches, keeping the guide within a storage
// budget.
//
// Guides usually list each channel's programmes together, so most records
// are complete when written. When a channel's day is split across batches,
// the later batch merges into the stored record.
//
// The budget: the TV allows each app only 80 MB. When the guide grows past
// the budget, the farthest day goes (from what is stored and from what comes
// next), so the nearest days are always kept. If even one day doesn't fit,
// it keeps as much of it as fits and stops storing; it stops too if the
// browser reports its quota is full.
//
// Guides give each channel's days together, so by the time the budget runs
// out, the first channels' later days would already be packed and stored
// for nothing. To avoid that, once a few hundred records are stored, the
// writer predicts the guide's size from their average and the number of
// channels the guide lists (`expectedChannels`), and drops days early.
//
// One batch is written while the next is parsed: flush() waits only for the
// batch before. IndexedDB runs transactions on the same store in order, so a
// merge always sees the earlier batch.

import { DAY, finished, isQuotaError, writeTransaction, type GuideDay } from "./db";
import { decodeDay, encodeDay, type StoredProgramme } from "./guideCodec";
import type { Programme } from "./types";

const HOUR = 3_600_000;
/** Programmes held before writing a batch. */
const BATCH = 20_000;
/** Roughly what each record costs besides its data: keys and bookkeeping. */
export const RECORD_OVERHEAD = 64;
/** A guess at a programme's packed size, until a merged record is packed. */
const PROGRAMME_GUESS = 64;
/** Records stored before predicting the guide's size from them. */
const PREDICT_AFTER = 300;

type Unfinished = Omit<Programme, "channel"> & { stop?: number };

// Sorts a day's programmes, drops repeats of the same start time (keeping
// the later one), and fills in missing stop times from the next programme.
const tidy = (programmes: Unfinished[]): StoredProgramme[] => {
  // Not toSorted(): older TVs' browsers lack it, and workers get no polyfills.
  const sorted = [...programmes];
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

interface Pending {
  channel: string;
  day: number;
  programmes: Unfinished[];
}

interface Stored {
  channel: string;
  day: number;
  bytes: number;
  count: number;
}

export interface GuideWriterOptions {
  source: string;
  /** Days to store, as days since 1970 (UTC). */
  firstDay: number;
  lastDay: number;
  budgetBytes: number;
}

export class GuideWriter {
  /** Programmes given to add(). */
  added = 0;
  /** Programmes left out: outside the days kept, or after storing stopped. */
  skipped = 0;
  /** The last day still kept; it moves earlier to stay within the budget. */
  lastDay: number;
  trimmed = false;
  /** Set when storing has stopped; see the top of this file. */
  stopped: "budget" | "quota" | undefined;
  /** The last batch's write, for probes. */
  writeState = "none";
  /** How many guide channels the guide lists, for predicting its size. */
  expectedChannels = 0;

  private db: IDBDatabase;
  private options: GuideWriterOptions;
  private pending = new Map<string, Pending>();
  private pendingCount = 0;
  /** Each stored record, by "channel\nday". */
  private stored = new Map<string, Stored>();
  private bytesByDay = new Map<number, number>();
  private writing: Promise<void> = Promise.resolve();

  constructor(db: IDBDatabase, options: GuideWriterOptions) {
    this.db = db;
    this.options = options;
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

  /** The last day with programmes stored, which may be before lastDay. */
  get lastStoredDay() {
    return this.guideDays().last;
  }

  /** Whether a record for this channel and day is stored. */
  has(channel: string, day: number) {
    return this.stored.has(`${channel}\n${day}`);
  }

  add(programme: Programme) {
    this.added++;
    const day = Math.floor(programme.start / DAY);
    if (this.stopped || day < this.options.firstDay || day > this.lastDay) {
      this.skipped++;
      return;
    }
    const { channel, ...rest } = programme;
    const key = `${channel}\n${day}`;
    let record = this.pending.get(key);
    if (!record) {
      record = { channel, day, programmes: [] };
      this.pending.set(key, record);
    }
    record.programmes.push(rest);
    this.pendingCount++;
  }

  /** Starts writing the waiting programmes, once the previous batch is written. */
  async flush() {
    await this.settle();
    const batch = [...this.pending.values()];
    this.pending = new Map();
    this.pendingCount = 0;
    if (this.stopped || batch.length === 0) return;

    // Pack new records first, so their sizes count against the budget.
    const before = { stored: new Map(this.stored), bytesByDay: new Map(this.bytesByDay) };
    const items = batch.map(record => {
      const key = `${record.channel}\n${record.day}`;
      if (this.stored.has(key)) return { key, record, data: undefined };
      const programmes = tidy(record.programmes);
      return { key, record, programmes, data: encodeDay(record.day, programmes) };
    });
    // A merge's size is known only in the transaction; until then, count
    // the old record plus a guess for the new programmes.
    const sizeOf = ({ key, record, programmes, data }: (typeof items)[number]): Stored => {
      const old = this.stored.get(key);
      const bytes = data ? data.length : (old?.bytes ?? 0) + record.programmes.length * PROGRAMME_GUESS;
      const count = programmes ? programmes.length : (old?.count ?? 0) + record.programmes.length;
      return { channel: record.channel, day: record.day, bytes: bytes + RECORD_OVERHEAD, count };
    };
    for (const item of items) this.account(item.key, sizeOf(item));
    let dropped = [...this.predict(), ...this.trim()];
    // With storing stopped, only the records of this batch that still fit.
    let fits: Set<string> | undefined;
    if (this.stopped) {
      // Not even one day fits: keep as much of it as the budget holds, in
      // the guide's order, and no more.
      this.stored = before.stored;
      this.bytesByDay = before.bytesByDay;
      dropped = this.dropAfter(this.lastDay);
      fits = new Set();
      for (const item of items) {
        if (item.record.day > this.lastDay) continue;
        const size = sizeOf(item);
        const old = this.stored.get(item.key)?.bytes ?? 0;
        if (this.bytes - old + size.bytes > this.options.budgetBytes) break;
        this.account(item.key, size);
        fits.add(item.key);
      }
    }

    const { source } = this.options;
    const transaction = writeTransaction(this.db, "guide");
    const store = transaction.objectStore("guide");
    for (const { channel, day } of dropped) store.delete([source, channel, day]);
    for (const { key, record, programmes, data } of items) {
      const { channel, day } = record;
      if (day > this.lastDay || (fits && !fits.has(key))) continue;
      if (data && programmes) {
        const value: GuideDay = { source, channel, day, count: programmes.length, data };
        store.put(value);
        continue;
      }
      const request = store.get([source, channel, day]);
      request.addEventListener("success", () => {
        const old: GuideDay | undefined = request.result;
        const merged = tidy(old ? [...decodeDay(day, old.data), ...record.programmes] : record.programmes);
        const packed = encodeDay(day, merged);
        this.account(key, { channel, day, bytes: packed.length + RECORD_OVERHEAD, count: merged.length });
        const value: GuideDay = { source, channel, day, count: merged.length, data: packed };
        store.put(value);
      });
    }
    this.writeState = "pending";
    this.writing = (async () => {
      try {
        await finished(transaction);
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

  /** Writes everything still waiting, and waits until it is stored. */
  async finish() {
    await this.flush();
    await this.settle();
  }

  // Waits for the batch being written. Full storage stops storing; any other
  // error ends the import.
  private async settle() {
    try {
      await this.writing;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      this.stop("quota");
    } finally {
      this.writing = Promise.resolve();
    }
  }

  private account(key: string, record: Stored) {
    const old = this.stored.get(key);
    if (old) this.bytesByDay.set(old.day, (this.bytesByDay.get(old.day) ?? 0) - old.bytes);
    this.stored.set(key, record);
    this.bytesByDay.set(record.day, (this.bytesByDay.get(record.day) ?? 0) + record.bytes);
  }

  // The days with programmes stored, within those kept. Guides give each
  // channel's days together, so after the first batch these are the guide's
  // own days. The days kept can reach further: catch-up keeps days before
  // today that a guide may not have, and counting those, the guide's own
  // days were dropped to fit the budget (PLAN.md, Phase 8, step 3).
  private guideDays() {
    let first = Infinity;
    let last = -Infinity;
    for (const day of this.bytesByDay.keys()) {
      first = Math.min(first, day);
      last = Math.max(last, day);
    }
    if (first === Infinity) return { first: this.options.firstDay, last: this.lastDay };
    return { first: Math.max(this.options.firstDay, first), last: Math.min(this.lastDay, last) };
  }

  // Drops days that the guide, predicted from what is stored so far, won't
  // have room for. Returns the stored records to delete.
  private predict() {
    const dropped: Stored[] = [];
    if (this.expectedChannels === 0 || this.stored.size < PREDICT_AFTER) return dropped;
    const perRecord = this.bytes / this.stored.size;
    const { budgetBytes } = this.options;
    const { first, last } = this.guideDays();
    const predicted = () => perRecord * this.expectedChannels * (Math.min(this.lastDay, last) - first + 1);
    // No margin: if the prediction is low, trim() still keeps the budget.
    while (predicted() > budgetBytes && this.lastDay > first) {
      this.lastDay = Math.min(this.lastDay, last) - 1;
      this.trimmed = true;
      dropped.push(...this.dropAfter(this.lastDay));
    }
    return dropped;
  }

  // Drops the farthest days until the guide fits the budget, and returns the
  // stored records to delete.
  private trim() {
    const dropped: Stored[] = [];
    while (this.bytes > this.options.budgetBytes) {
      if (this.lastDay <= this.guideDays().first) {
        // Not even the first day fits: flush() keeps what fits, and stops.
        this.stop("budget");
        break;
      }
      this.lastDay = Math.min(this.lastDay, this.guideDays().last) - 1;
      this.trimmed = true;
      dropped.push(...this.dropAfter(this.lastDay));
    }
    return dropped;
  }

  // Forgets the records after `day`, and returns them to delete.
  private dropAfter(day: number) {
    const dropped: Stored[] = [];
    for (const [key, record] of this.stored) {
      if (record.day <= day) continue;
      this.stored.delete(key);
      this.bytesByDay.delete(record.day);
      dropped.push(record);
    }
    return dropped;
  }

  private stop(reason: "budget" | "quota") {
    this.stopped ??= reason;
    this.trimmed = true;
  }
}
