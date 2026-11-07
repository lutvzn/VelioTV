// Reads guide days from the store and unpacks them. It runs in the guide
// worker (guide.worker.ts), so that unpacking, which took 62-103 ms for a
// guide screen on the TV's main thread (PLAN.md, Phase 2), never holds up the
// UI.
//
// The store keeps a record per guide channel per day of start times, so a
// day's programmes are that day's record plus the end of the day before's.
// Unpacked records are kept for a while, so reading the next day of a channel
// reuses the day it shares.

import { DAY, type GuideDay, request } from "./db";
import { decodeDay, type StoredProgramme } from "./guideCodec";

export interface DayRequest {
  source: string;
  /** A guide channel id. */
  channel: string;
  /** Days since 1970, UTC. */
  day: number;
}

/** Time spent, for probes. */
export interface ReadStats {
  /** Reading records from IndexedDB, in milliseconds. */
  getMs: number;
  /** Unpacking them. */
  decodeMs: number;
  /** Records unpacked; the others were kept from earlier reads or don't exist. */
  decoded: number;
}

const keyOf = (source: string, channel: string, day: number) => `${source}\n${channel}\n${day}`;

export const createGuideReader = (openDb: () => Promise<IDBDatabase>, options: { keep?: number } = {}) => {
  const keep = options.keep ?? 100;
  // Unpacked records, in order of use, oldest first.
  const unpacked = new Map<string, StoredProgramme[]>();
  let db: Promise<IDBDatabase> | undefined;

  const connect = () =>
    (db ??= openDb().then(opened => {
      // Let a newer version or a deletion through, and reopen next time.
      opened.addEventListener("versionchange", () => {
        opened.close();
        db = undefined;
      });
      return opened;
    }));

  const remember = (key: string, programmes: StoredProgramme[]) => {
    unpacked.delete(key);
    unpacked.set(key, programmes);
    while (unpacked.size > keep) {
      const oldest = unpacked.keys().next().value;
      if (oldest === undefined) break;
      unpacked.delete(oldest);
    }
  };

  /** The programmes that overlap each requested UTC day, in start order. */
  const read = async (requests: DayRequest[]) => {
    const stats: ReadStats = { getMs: 0, decodeMs: 0, decoded: 0 };
    // Each request needs its day's record and the day before's.
    const found = new Map<string, StoredProgramme[]>();
    const wanted = new Map<string, DayRequest>();
    for (const { source, channel, day } of requests) {
      for (const d of [day - 1, day]) {
        const key = keyOf(source, channel, d);
        const kept = unpacked.get(key);
        if (kept) found.set(key, kept);
        else wanted.set(key, { source, channel, day: d });
      }
    }

    if (wanted.size > 0) {
      const opened = await connect();
      const started = performance.now();
      const store = opened.transaction("guide").objectStore("guide");
      const records = await Promise.all(
        Array.from(wanted.values(), ({ source, channel, day }) =>
          request<GuideDay | undefined>(store.get([source, channel, day])),
        ),
      );
      const got = performance.now();
      stats.getMs = got - started;
      let i = 0;
      for (const key of wanted.keys()) {
        const record = records[i++];
        // A day with no record has no programmes.
        found.set(key, record ? decodeDay(record.day, record.data) : []);
        if (record) stats.decoded++;
      }
      stats.decodeMs = performance.now() - got;
    }
    for (const [key, programmes] of found) remember(key, programmes);

    const days = requests.map(({ source, channel, day }) => {
      const before = found.get(keyOf(source, channel, day - 1)) ?? [];
      const today = found.get(keyOf(source, channel, day)) ?? [];
      const from = day * DAY;
      const programmes = before.filter(p => p.stop > from).concat(today);
      // toSorted() needs Chromium 110; older TVs are still targets.
      // oxlint-disable-next-line unicorn/no-array-sort
      return programmes.sort((a, b) => a.start - b.start);
    });
    return { days, stats };
  };

  return {
    read,
    /** Forgets what was unpacked, such as after an import replaced the guide. */
    clear: () => unpacked.clear(),
  };
};
