// Reads guide blocks from the store and unpacks them. It runs in the guide
// worker (guide.worker.ts), so that unpacking never holds up the UI.
//
// Each source's guide index says which block holds a channel's day (db.ts);
// a day's programmes are that day's block plus the end of the day before's.
// The index and the last few unpacked blocks are kept, so the channels next
// to one just read, and its other days, mostly cost nothing.

import {
  type BlockKey,
  createLookup,
  type GuideBlock,
  type GuideIndex,
  type GuideLookup,
  request,
} from "./db";
import { DAY, decodeBlock, type StoredProgramme } from "./guideCodec";

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
  /** Blocks unpacked; the others were kept from earlier reads. */
  decoded: number;
}

const textOf = (key: BlockKey) => key.join("\n");

export const createGuideReader = (openDb: () => Promise<IDBDatabase>, options: { keep?: number } = {}) => {
  const keep = options.keep ?? 8;
  // Unpacked blocks, in order of use, oldest first.
  const unpacked = new Map<string, Map<string, StoredProgramme[]>>();
  const lookups = new Map<string, GuideLookup | undefined>();
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

  const remember = (key: string, channels: Map<string, StoredProgramme[]>) => {
    unpacked.delete(key);
    unpacked.set(key, channels);
    while (unpacked.size > keep) {
      const oldest = unpacked.keys().next().value;
      if (oldest === undefined) break;
      unpacked.delete(oldest);
    }
  };

  /** The programmes that overlap each requested UTC day, in start order. */
  const read = async (requests: DayRequest[]) => {
    const stats: ReadStats = { getMs: 0, decodeMs: 0, decoded: 0 };
    const opened = await connect();
    const started = performance.now();

    const sources = [...new Set(requests.map(r => r.source))].filter(source => !lookups.has(source));
    if (sources.length > 0) {
      const store = opened.transaction("guideIndex").objectStore("guideIndex");
      const indexes = await Promise.all(
        sources.map(source => request<GuideIndex | undefined>(store.get(source))),
      );
      sources.forEach((source, i) => {
        const index = indexes[i];
        lookups.set(source, index && createLookup(index));
      });
    }

    // Each request needs its day's block and the day before's.
    const keysOf = ({ source, channel, day }: DayRequest) => {
      const keys: BlockKey[] = [];
      for (const d of [day - 1, day]) {
        const key = lookups.get(source)?.blockKey(channel, d);
        if (key) keys.push(key);
      }
      return keys;
    };
    const wanted = new Map<string, BlockKey>();
    for (const r of requests) {
      for (const key of keysOf(r)) if (!unpacked.has(textOf(key))) wanted.set(textOf(key), key);
    }
    const found = new Map<string, Map<string, StoredProgramme[]>>();
    if (wanted.size > 0) {
      const store = opened.transaction("guide").objectStore("guide");
      const blocks = await Promise.all(
        Array.from(wanted.values(), key => request<GuideBlock | undefined>(store.get(key))),
      );
      const got = performance.now();
      stats.getMs = got - started;
      let i = 0;
      for (const [text, key] of wanted) {
        const block = blocks[i++];
        if (block) {
          found.set(text, decodeBlock(block.day, block.data));
          stats.decoded++;
        } else {
          // An import replaced the guide since its index was read.
          lookups.delete(key[0]);
        }
      }
      stats.decodeMs = performance.now() - got;
    }
    for (const [text, channels] of found) remember(text, channels);

    const days = requests.map(r => {
      const from = r.day * DAY;
      const programmes: StoredProgramme[] = [];
      for (const key of keysOf(r)) {
        const list = (unpacked.get(textOf(key)) ?? found.get(textOf(key)))?.get(r.channel) ?? [];
        for (const p of list) if (p.stop > from && p.start < from + DAY) programmes.push(p);
      }
      // toSorted() needs Chromium 110; older TVs are still targets.
      // oxlint-disable-next-line unicorn/no-array-sort
      return programmes.sort((a, b) => a.start - b.start);
    });
    return { days, stats };
  };

  return {
    read,
    /** Forgets what was read, such as after an import replaced the guide. */
    clear: () => {
      unpacked.clear();
      lookups.clear();
    },
  };
};
