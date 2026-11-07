// Reads guide blocks from the store and unpacks them. It runs in the guide
// worker (guide.worker.ts), so that unpacking never holds up the UI.
//
// Each source's import state names its guide, and the guide's index says
// which block holds a channel's day (db.ts); a day's programmes are that
// day's block plus the end of the day before's. Rows need only a block's
// grid part; a programme's subtitle and description are in its details
// part, unpacked when the programme is focused (guideCodec.ts). The index,
// the last few blocks' grids, and the last couple with their details are
// kept, so the channels next to one just read, and its other days, mostly
// cost nothing.

import {
  type BlockKey,
  createLookup,
  type GuideBlock,
  type GuideIndex,
  type GuideLookup,
  type ImportState,
  request,
} from "./db";
import { DAY, decodeBlock, type ProgrammeDetails, type StoredProgramme } from "./guideCodec";

export interface DayRequest {
  source: string;
  /** A guide channel id. */
  channel: string;
  /** Days since 1970, UTC. */
  day: number;
}

export interface DetailsRequest {
  source: string;
  channel: string;
  /** The programme's start time. */
  start: number;
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

type Unpacked = Map<string, StoredProgramme[]>;

const textOf = (key: BlockKey) => key.join("\n");

// The last `keep` values used, oldest first.
const recent = <T>(keep: number) => {
  const values = new Map<string, T>();
  return {
    get: (key: string) => values.get(key),
    has: (key: string) => values.has(key),
    set: (key: string, value: T) => {
      values.delete(key);
      values.set(key, value);
      while (values.size > keep) {
        const oldest = values.keys().next().value;
        if (oldest === undefined) break;
        values.delete(oldest);
      }
    },
    clear: () => values.clear(),
  };
};

export const createGuideReader = (
  openDb: () => Promise<IDBDatabase>,
  options: { keep?: number; keepDetails?: number } = {},
) => {
  // Blocks' grids, and blocks with their details.
  const grids = recent<Unpacked>(options.keep ?? 8);
  const full = recent<Unpacked>(options.keepDetails ?? 2);
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

  // Reads the lookups of sources not read yet.
  const lookUp = async (opened: IDBDatabase, sources: string[]) => {
    const missing = [...new Set(sources)].filter(source => !lookups.has(source));
    if (missing.length === 0) return;
    const transaction = opened.transaction(["imports", "guideIndex"]);
    const imports = transaction.objectStore("imports");
    const indexes = transaction.objectStore("guideIndex");
    await Promise.all(
      missing.map(async source => {
        const state = await request<ImportState | undefined>(imports.get(source));
        const index =
          state?.guide === undefined
            ? undefined
            : await request<GuideIndex | undefined>(indexes.get(state.guide));
        lookups.set(source, index && createLookup(index));
      }),
    );
  };

  // Reads blocks; a missing one means an import replaced the guide since its
  // index was read, so the source's lookup is read again next time.
  const getBlocks = async (opened: IDBDatabase, wanted: Map<string, { key: BlockKey; source: string }>) => {
    const store = opened.transaction("guide").objectStore("guide");
    const blocks = await Promise.all(
      Array.from(wanted.values(), ({ key }) => request<GuideBlock | undefined>(store.get(key))),
    );
    const found = new Map<string, GuideBlock>();
    let i = 0;
    for (const [text, { source }] of wanted) {
      const block = blocks[i++];
      if (block) found.set(text, block);
      else lookups.delete(source);
    }
    return found;
  };

  /** The programmes that overlap each requested UTC day, in start order, without their details. */
  const read = async (requests: DayRequest[]) => {
    const stats: ReadStats = { getMs: 0, decodeMs: 0, decoded: 0 };
    const opened = await connect();
    const started = performance.now();
    await lookUp(
      opened,
      requests.map(r => r.source),
    );

    // Each request needs its day's block and the day before's.
    const keysOf = ({ source, channel, day }: DayRequest) => {
      const keys: BlockKey[] = [];
      for (const d of [day - 1, day]) {
        const key = lookups.get(source)?.blockKey(channel, d);
        if (key) keys.push(key);
      }
      return keys;
    };
    const wanted = new Map<string, { key: BlockKey; source: string }>();
    for (const r of requests) {
      for (const key of keysOf(r))
        if (!grids.has(textOf(key))) wanted.set(textOf(key), { key, source: r.source });
    }
    const found = new Map<string, Unpacked>();
    if (wanted.size > 0) {
      const blocks = await getBlocks(opened, wanted);
      const got = performance.now();
      stats.getMs = got - started;
      for (const [text, block] of blocks) {
        found.set(text, decodeBlock(block.day, block.data));
        stats.decoded++;
      }
      stats.decodeMs = performance.now() - got;
    }
    for (const [text, channels] of found) grids.set(text, channels);

    const days = requests.map(r => {
      const from = r.day * DAY;
      const channel = r.channel.toLowerCase();
      const programmes: StoredProgramme[] = [];
      for (const key of keysOf(r)) {
        const list = (grids.get(textOf(key)) ?? found.get(textOf(key)))?.get(channel) ?? [];
        for (const p of list) if (p.stop > from && p.start < from + DAY) programmes.push(p);
      }
      // toSorted() needs Chromium 110; older TVs are still targets.
      // oxlint-disable-next-line unicorn/no-array-sort
      return programmes.sort((a, b) => a.start - b.start);
    });
    return { days, stats };
  };

  /** A programme's subtitle and description, from its block's details part. */
  const details = async ({ source, channel, start }: DetailsRequest): Promise<ProgrammeDetails> => {
    const opened = await connect();
    await lookUp(opened, [source]);
    const key = lookups.get(source)?.blockKey(channel, Math.floor(start / DAY));
    if (!key) return {};
    const text = textOf(key);
    let channels = full.get(text);
    if (!channels) {
      const block = (await getBlocks(opened, new Map([[text, { key, source }]]))).get(text);
      if (!block) return {};
      channels = decodeBlock(block.day, block.data, block.details);
      full.set(text, channels);
    }
    const programme = channels.get(channel.toLowerCase())?.find(p => p.start === start);
    const found: ProgrammeDetails = {};
    if (programme?.subTitle !== undefined) found.subTitle = programme.subTitle;
    if (programme?.description !== undefined) found.description = programme.description;
    return found;
  };

  return {
    read,
    details,
    /** Forgets what was read, such as after an import replaced the guide. */
    clear: () => {
      grids.clear();
      full.clear();
      lookups.clear();
    },
  };
};
