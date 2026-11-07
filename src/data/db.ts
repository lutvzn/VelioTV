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
// (PLAN.md, Phase 8, step 2). A source's guide index says where each
// channel's block is. Each import writes a new generation of blocks beside
// the last one, and switches the index to it at the end, deleting the last
// one in the same transaction: the guide reads whole until then, and an
// import that fails leaves it as it was. If storage fills up first, the
// last generation goes early, to make room (guideWriter.ts).
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
const VERSION = 5;
const STORES = ["imports", "channelLists", "guide", "guideIndex", "vod"];

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
}

export interface StoredChannelList {
  source: string;
  columns: ChannelColumns;
}

export interface GuideBlock {
  source: string;
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
  /** The programmes, packed by guideCodec.ts. */
  data: Uint8Array;
}

/** Where a source's guide channels are in its blocks. */
export interface GuideIndex {
  source: string;
  /** The generation of blocks it describes. */
  generation: number;
  /** Guide channel ids, in the guide's order. */
  channels: string[];
  /**
   * For each day, the place in `channels` where each block starts. A block
   * holds the channels from its start up to the next block's.
   */
  days: Record<number, number[]>;
}

export type BlockKey = [source: string, generation: number, day: number, block: number];

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
    generation: index.generation,
    /** The key of the block with a channel's day, if the guide has that day. */
    blockKey: (channel: string, day: number): BlockKey | undefined => {
      const position = positions.get(channel);
      const starts = index.days[day];
      if (position === undefined || !starts?.length) return undefined;
      return [index.source, index.generation, day, blockAt(starts, position)];
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
    if (event.oldVersion < 5) {
      // Version 5 stores the guide in blocks. Version 3's records (one per
      // channel per day) go, and every source is due to import again, so its
      // guide comes back at the app's next check. The guide channels' names
      // go too: the app never showed them.
      for (const store of ["guide", "guideChannels"]) {
        if (db.objectStoreNames.contains(store)) db.deleteObjectStore(store);
      }
      db.createObjectStore("guide", { keyPath: ["source", "generation", "day", "block"] });
      db.createObjectStore("guideIndex", { keyPath: "source" });
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

/** Replaces a source's channel list. */
export const writeChannels = async (db: IDBDatabase, source: string, channels: PlaylistChannel[]) => {
  const transaction = writeTransaction(db, "channelLists");
  const list: StoredChannelList = { source, columns: toColumns(channels) };
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

export const readGuideIndex = (db: IDBDatabase, source: string) =>
  request<GuideIndex | undefined>(db.transaction("guideIndex").objectStore("guideIndex").get(source));

/** A source's blocks of one generation. */
export const generationRange = (source: string, generation: number) =>
  IDBKeyRange.bound([source, generation], [source, generation, []]);

/** Deletes a source's blocks of every generation but `keep`. */
export const deleteOtherGenerations = (store: IDBObjectStore, source: string, keep: number) => {
  store.delete(IDBKeyRange.bound([source], [source, keep], false, true));
  store.delete(IDBKeyRange.bound([source, keep + 1], [source, []]));
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
  const index = await readGuideIndex(db, source);
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
      ? (decodeBlock(block.day, block.data).get(channel) ?? []).filter(p => p.stop > from && p.start < to)
      : [],
  );
};

/** A source's stored guide: its programmes, bytes, blocks and last day. */
export const measureGuide = async (db: IDBDatabase, source: string) => {
  const index = await readGuideIndex(db, source);
  const transaction = db.transaction("guide");
  let programmes = 0;
  let bytes = 0;
  let records = 0;
  let lastDay: number | undefined;
  await new Promise<void>((resolve, reject) => {
    if (!index) return resolve();
    const r = transaction.objectStore("guide").openCursor(generationRange(source, index.generation));
    r.addEventListener("success", () => {
      const cursor = r.result;
      if (!cursor) return resolve();
      const value: GuideBlock = cursor.value;
      programmes += value.count;
      bytes += value.data.byteLength;
      records++;
      lastDay = Math.max(lastDay ?? value.day, value.day);
      cursor.continue();
    });
    r.addEventListener("error", () => reject(r.error ?? new Error("Couldn't read the guide")));
  });
  return { programmes, bytes, records, lastDay };
};

/** Deletes a source's data and import state. */
export const deleteSource = async (db: IDBDatabase, source: string) => {
  const transaction = writeTransaction(db, STORES);
  transaction.objectStore("guideIndex").delete(source);
  transaction.objectStore("guide").delete(sourceRange(source));
  transaction.objectStore("channelLists").delete(source);
  transaction.objectStore("vod").delete(source);
  transaction.objectStore("imports").delete(source);
  await finished(transaction);
};
