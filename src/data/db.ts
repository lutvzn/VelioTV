// The IndexedDB database that holds imported sources.
//
// Records are keyed by source first. A refresh replaces a source's channel
// list, films and series at the end of their stage.
//
// A source's channel list is one record, with a column per field
// (channelList.ts), which reads about 17 times faster than a record per
// channel.
//
// The guide (PLAN.md, Phase 8, step 2) is stored in blocks: each holds a day
// (UTC) of a run of guide channels, in the guide's order, compressed
// (guideCodec.ts) to over 64 KB. Chromium keeps values over 64 KB as files of
// their own and gives their space back as soon as they are deleted; smaller
// ones keep theirs until the database compacts, which the TV didn't do
// (PLAN.md, Phase 8, step 2). A guide's index says where each channel's
// block is. Each import writes a new generation of blocks beside the last
// one, and switches the index to it at the end, deleting the last one in the
// same transaction: the guide reads whole until then, and an import that
// fails leaves it as it was. If storage fills up first, the last generation
// goes early, to make room (guideWriter.ts).
//
// Guides are keyed by their addresses (guideKey), so sources that use the
// same guide, such as two lines from one provider, store it once
// (PLAN.md, Phase 8, step 2). A source's import state names the guide it
// uses; a guide no source names is deleted. Its record in "guides" says what
// the last import kept, so that another import can tell whether it must
// download it again (importer.ts).
//
// Writes use relaxed durability, which was about 20 times faster on the TV.
//
// A source's films and series are one record too (vod.ts; PLAN.md, Phase 6).

import { type ChannelColumns, fromColumns, type StoredChannel, toColumns } from "./channelList";
import { DAY, decodeBlock, type StoredProgramme } from "./guideCodec";
import type { PlaylistChannel } from "./types";
import type { StoredVod } from "./vod";
import type { XtreamAccount } from "./xtream";

export { DAY, type StoredChannel, type StoredProgramme };

export const DB_NAME = "tiviplayer";
const VERSION = 6;
const STORES = ["imports", "channelLists", "guide", "guideIndex", "guides", "vod"];

/** How a source's last import went. */
export interface ImportState {
  source: string;
  status: "importing" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  /** When an import of this source last finished without failing. */
  lastDoneAt?: number;
  error?: string;
  /**
   * The counts below describe the data stored. While importing, or after an
   * import failed, they are the last finished import's.
   */
  channels: number;
  guideChannels: number;
  /** Programmes stored. */
  programmes: number;
  /** Compressed size of the stored guide. */
  guideBytes: number;
  /** The days stored, as days since 1970 (UTC). */
  guideFirstDay: number;
  guideLastDay: number;
  /** Whether days were left out to stay within the storage budget. */
  guideTrimmed: boolean;
  /** An Xtream account's details, from its last import. */
  account?: XtreamAccount;
  /** Films and series stored, from imports since Phase 6. */
  films?: number;
  series?: number;
  /** The key of the guide it uses (guideKey), if it has one. */
  guide?: string;
}

export interface StoredChannelList {
  source: string;
  columns: ChannelColumns;
}

export interface GuideBlock {
  /** The guide's key (guideKey). */
  guide: string;
  /** The import that wrote it; see the top of this file. */
  generation: number;
  /** Days since 1970, UTC, of the programmes' start times. */
  day: number;
  /** Its place among the day's blocks (GuideIndex.days). */
  block: number;
  /** Guide channels in it. */
  channels: number;
  /** Programmes in it. */
  count: number;
  /** The programmes' grid, packed by guideCodec.ts. */
  data: Uint8Array;
  /** Their subtitles and descriptions, for days that keep them. */
  details?: Uint8Array;
}

/** Where a guide's channels are in its blocks. */
export interface GuideIndex {
  guide: string;
  /** The generation of blocks it describes. */
  generation: number;
  /** Guide channel ids, lower-cased, in the guide's order. */
  channels: string[];
  /**
   * For each day, the place in `channels` where each block starts. A block
   * holds the channels from its start up to the next block's.
   */
  days: Record<number, number[]>;
}

/** What a guide's last import kept, and how to ask whether the guide changed since (importer.ts). */
export interface GuideMeta {
  guide: string;
  urls: string[];
  /** When it was imported, and for which source. */
  importedAt: number;
  importedBy: string;
  /** The UTC day it was imported on, which sets the days with details (guideWriter.ts). */
  today: number;
  /** The last day it was asked for, and the budget. */
  lastDay: number;
  budgetBytes: number;
  /**
   * The channels kept, as lower-cased guide ids, each with the time its
   * programmes were kept from (those ending later). With `all`, every
   * channel was kept from then.
   */
  wanted: { ids: string[]; from: number[]; all?: number };
  /** Each address's ETag and Last-Modified, when the server sent them. */
  validators: Record<string, { etag?: string; lastModified?: string }>;
  /** What is stored, for the state of a source that uses it as it is. */
  stored: Pick<
    ImportState,
    "guideChannels" | "programmes" | "guideBytes" | "guideFirstDay" | "guideLastDay" | "guideTrimmed"
  >;
}

/** The key of the guide made from these addresses. */
export const guideKey = (urls: readonly string[], offsetMinutes?: number) =>
  urls.length === 0
    ? undefined
    : urls.join("\n") + (offsetMinutes === undefined ? "" : `\n@${offsetMinutes}`);

export type BlockKey = [guide: string, generation: number, day: number, block: number];

/** The block of `starts` (a GuideIndex day) that holds a channel's place. */
export const blockAt = (starts: readonly number[], position: number) => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
};

/** Finds channels' blocks quickly in an index. */
export const createLookup = (index: GuideIndex) => {
  const positions = new Map(index.channels.map((channel, i) => [channel, i]));
  return {
    guide: index.guide,
    generation: index.generation,
    /** The key of the block with a channel's day, if the guide has that day. */
    blockKey: (channel: string, day: number): BlockKey | undefined => {
      const position = positions.get(channel.toLowerCase());
      const starts = index.days[day];
      if (position === undefined || !starts?.length) return undefined;
      return [index.guide, index.generation, day, blockAt(starts, position)];
    },
  };
};

export type GuideLookup = ReturnType<typeof createLookup>;

/** A request's result. IndexedDB can't check stored types, so callers name them. */
export const request = <T = unknown>(r: IDBRequest) =>
  new Promise<T>((resolve, reject) => {
    r.addEventListener("success", () => resolve(r.result));
    r.addEventListener("error", () => reject(r.error ?? new Error("IndexedDB request failed")));
  });

export const finished = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Transaction failed")));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Transaction aborted")),
    );
  });

/** A write transaction that may skip flushing to disk; see the top of this file. */
export const writeTransaction = (db: IDBDatabase, stores: string | string[]) =>
  db.transaction(stores, "readwrite", { durability: "relaxed" });

export const isQuotaError = (error: unknown) =>
  error instanceof DOMException && error.name === "QuotaExceededError";

export const openDb = (name = DB_NAME): Promise<IDBDatabase> => {
  const r = indexedDB.open(name, VERSION);
  r.addEventListener("upgradeneeded", event => {
    const db = r.result;
    if (event.oldVersion < 3) {
      // Earlier versions (records keyed by import id, then a record per
      // channel) hold nothing that can't be imported again, and without their
      // import states the app imports every source again at its next check.
      for (const store of Array.from(db.objectStoreNames)) db.deleteObjectStore(store);
      db.createObjectStore("imports", { keyPath: "source" });
      db.createObjectStore("channelLists", { keyPath: "source" });
    }
    // Version 4 adds films and series, keeping what version 3 holds; they
    // come with each source's next import.
    if (!db.objectStoreNames.contains("vod")) db.createObjectStore("vod", { keyPath: "source" });
    if (event.oldVersion < 6) {
      // Version 5 stored the guide in blocks, and version 6 in blocks of two
      // parts, keyed by the guide rather than the source. The guide from
      // before goes (version 3's was a record per channel per day), and
      // every source is due to import again, so its guide comes back at the
      // app's next check.
      for (const store of ["guide", "guideChannels", "guideIndex", "guides"]) {
        if (db.objectStoreNames.contains(store)) db.deleteObjectStore(store);
      }
      db.createObjectStore("guide", { keyPath: ["guide", "generation", "day", "block"] });
      db.createObjectStore("guideIndex", { keyPath: "guide" });
      db.createObjectStore("guides", { keyPath: "guide" });
      const imports = r.transaction?.objectStore("imports").openCursor();
      imports?.addEventListener("success", () => {
        const cursor = imports.result;
        if (!cursor) return;
        const state: ImportState = cursor.value;
        cursor.update({ ...state, programmes: 0, guideBytes: 0, guideTrimmed: false, lastDoneAt: 0 });
        cursor.continue();
      });
    }
  });
  return request(r);
};

export const deleteDb = (name = DB_NAME) => request<void>(indexedDB.deleteDatabase(name));

/**
 * Opens the database once as the app starts, so that an upgrade runs before
 * anything else uses it. If it can't be opened, it is deleted and made
 * again: everything in it can be imported again, and the sources' list
 * lives elsewhere. On the TV an upgrade couldn't commit once the space of
 * deleted records had filled the storage, and deleting the database gave
 * the space back (PLAN.md, Phase 8, step 2).
 */
export const prepareDb = async (name = DB_NAME): Promise<"opened" | "remade"> => {
  try {
    (await openDb(name)).close();
    return "opened";
  } catch (error) {
    console.error("Couldn't open the database, so it is made again and the sources import again:", error);
    await deleteDb(name);
    (await openDb(name)).close();
    return "remade";
  }
};

// Arrays sort after every other key type, so [source, []] is above every key
// that starts with source.
export const sourceRange = (source: string) => IDBKeyRange.bound([source], [source, []]);

export const readImport = (db: IDBDatabase, source: string) =>
  request<ImportState | undefined>(db.transaction("imports").objectStore("imports").get(source));

export const readImports = (db: IDBDatabase) =>
  request<ImportState[]>(db.transaction("imports").objectStore("imports").getAll());

/** Replaces a source's channel list; `keys` are the channels' keys, if already worked out. */
export const writeChannels = async (
  db: IDBDatabase,
  source: string,
  channels: PlaylistChannel[],
  keys?: string[],
) => {
  const transaction = writeTransaction(db, "channelLists");
  const list: StoredChannelList = { source, columns: toColumns(channels, keys) };
  transaction.objectStore("channelLists").put(list);
  await finished(transaction);
};

/** Replaces a source's films and series. */
export const writeVod = async (db: IDBDatabase, vod: StoredVod) => {
  const transaction = writeTransaction(db, "vod");
  transaction.objectStore("vod").put(vod);
  await finished(transaction);
};

/** A source's films and series; empty if it has none, or hasn't been imported since Phase 6. */
export const readVod = async (db: IDBDatabase, source: string): Promise<StoredVod> => {
  const stored = await request<StoredVod | undefined>(db.transaction("vod").objectStore("vod").get(source));
  return stored ?? { source, films: [], series: [] };
};

/** A source's channels, in playlist order. */
export const readChannels = async (db: IDBDatabase, source: string): Promise<StoredChannel[]> => {
  const store = db.transaction("channelLists").objectStore("channelLists");
  const list = await request<StoredChannelList | undefined>(store.get(source));
  return list ? fromColumns(list.columns, source) : [];
};

export const readGuideIndex = (db: IDBDatabase, guide: string) =>
  request<GuideIndex | undefined>(db.transaction("guideIndex").objectStore("guideIndex").get(guide));

export const readGuideMeta = (db: IDBDatabase, guide: string) =>
  request<GuideMeta | undefined>(db.transaction("guides").objectStore("guides").get(guide));

/** The key of the guide a source uses, if it has one. */
export const guideOf = async (db: IDBDatabase, source: string) => (await readImport(db, source))?.guide;

/** A guide's blocks of one generation. */
export const generationRange = (guide: string, generation: number) =>
  IDBKeyRange.bound([guide, generation], [guide, generation, []]);

/** Deletes a guide's blocks of every generation but `keep`. */
export const deleteOtherGenerations = (store: IDBObjectStore, guide: string, keep: number) => {
  store.delete(IDBKeyRange.bound([guide], [guide, keep], false, true));
  store.delete(IDBKeyRange.bound([guide, keep + 1], [guide, []]));
};

/** Deletes a guide: its blocks, index and record, in a transaction on those stores. */
const deleteGuide = (transaction: IDBTransaction, guide: string) => {
  transaction.objectStore("guide").delete(sourceRange(guide));
  transaction.objectStore("guideIndex").delete(guide);
  transaction.objectStore("guides").delete(guide);
};

const GUIDE_STORES = ["imports", "guide", "guideIndex", "guides"];

/**
 * Deletes every guide no source's import state names, including blocks an
 * import cut short left behind. Imports run one at a time, and this runs at
 * the end of one, so no other import is writing.
 */
export const deleteUnusedGuides = async (db: IDBDatabase) => {
  const transaction = writeTransaction(db, GUIDE_STORES);
  const states = await request<ImportState[]>(transaction.objectStore("imports").getAll());
  const used = new Set(states.map(state => state.guide).filter(guide => guide !== undefined));
  const unused = new Set<string>();
  for (const store of ["guideIndex", "guides"]) {
    const keys = await request<IDBValidKey[]>(transaction.objectStore(store).getAllKeys());
    for (const key of keys) if (typeof key === "string" && !used.has(key)) unused.add(key);
  }
  // The blocks' guides, one key each: the cursor jumps past each guide's blocks.
  await new Promise<void>((resolve, reject) => {
    const r = transaction.objectStore("guide").openKeyCursor();
    r.addEventListener("success", () => {
      const cursor = r.result;
      if (!cursor) return resolve();
      // The store's keys are BlockKeys.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const [guide] = cursor.key as BlockKey;
      if (!used.has(guide)) unused.add(guide);
      cursor.continue([guide, []]);
    });
    r.addEventListener("error", () => reject(r.error ?? new Error("Couldn't list the guides")));
  });
  for (const guide of unused) deleteGuide(transaction, guide);
  await finished(transaction);
  return [...unused];
};

/**
 * A guide channel's programmes that overlap `from`..`to`. It also reads the
 * day before, for programmes that started then and are still on. The guide
 * worker reads the guide for the app (guideReader.ts); this is for tests and
 * probes.
 */
export const readGuide = async (
  db: IDBDatabase,
  source: string,
  channel: string,
  from: number,
  to: number,
): Promise<StoredProgramme[]> => {
  const guide = await guideOf(db, source);
  const index = guide === undefined ? undefined : await readGuideIndex(db, guide);
  if (!index) return [];
  const lookup = createLookup(index);
  const keys: BlockKey[] = [];
  for (let day = Math.floor(from / DAY) - 1; day <= Math.floor(to / DAY); day++) {
    const key = lookup.blockKey(channel, day);
    if (key) keys.push(key);
  }
  const store = db.transaction("guide").objectStore("guide");
  const blocks = await Promise.all(keys.map(key => request<GuideBlock | undefined>(store.get(key))));
  return blocks.flatMap(block =>
    block
      ? (decodeBlock(block.day, block.data, block.details).get(channel.toLowerCase()) ?? []).filter(
          p => p.stop > from && p.start < to,
        )
      : [],
  );
};

/** A guide as stored (or one generation of it): its programmes, bytes, blocks and last day. */
export const measureGuide = async (db: IDBDatabase, guide: string, generation?: number) => {
  const index = generation === undefined ? await readGuideIndex(db, guide) : { generation };
  const transaction = db.transaction("guide");
  let programmes = 0;
  let bytes = 0;
  let records = 0;
  let lastDay: number | undefined;
  await new Promise<void>((resolve, reject) => {
    if (!index) return resolve();
    const r = transaction.objectStore("guide").openCursor(generationRange(guide, index.generation));
    r.addEventListener("success", () => {
      const cursor = r.result;
      if (!cursor) return resolve();
      const value: GuideBlock = cursor.value;
      programmes += value.count;
      bytes += value.data.byteLength + (value.details?.byteLength ?? 0);
      records++;
      lastDay = Math.max(lastDay ?? value.day, value.day);
      cursor.continue();
    });
    r.addEventListener("error", () => reject(r.error ?? new Error("Couldn't read the guide")));
  });
  return { programmes, bytes, records, lastDay };
};

/** Deletes a source's data and import state, and its guide unless another source uses it. */
export const deleteSource = async (db: IDBDatabase, source: string) => {
  const transaction = writeTransaction(db, STORES);
  const imports = transaction.objectStore("imports");
  const states = await request<ImportState[]>(imports.getAll());
  const guide = states.find(state => state.source === source)?.guide;
  if (guide !== undefined && !states.some(state => state.source !== source && state.guide === guide)) {
    deleteGuide(transaction, guide);
  }
  transaction.objectStore("channelLists").delete(source);
  transaction.objectStore("vod").delete(source);
  imports.delete(source);
  await finished(transaction);
};
