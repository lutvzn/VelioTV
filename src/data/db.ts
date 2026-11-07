// The IndexedDB database that holds imported sources.
//
// Records are keyed by source first. A refresh overwrites a source's records
// in place, then deletes the ones it didn't write: keeping the old import
// beside the new one would need twice the space, and the TV allows each app
// only 80 MB (PLAN.md, Phase 2). If a refresh fails partway, a source has a
// mix of old and new data, which is still usable.
//
// A source's channel list is one record, with a column per field
// (channelList.ts), which reads about 17 times faster than a record per
// channel.
//
// The guide is stored as one record per guide channel per day (UTC), holding
// that day's programmes compressed (guideCodec.ts), written with relaxed
// durability, which was about 20 times faster on the TV than one record per
// programme.
//
// A source's films and series are one record too (vod.ts; PLAN.md, Phase 6).

import { type ChannelColumns, fromColumns, type StoredChannel, toColumns } from "./channelList";
import { DAY, decodeDay, type StoredProgramme } from "./guideCodec";
import type { GuideChannel, PlaylistChannel } from "./types";
import type { StoredVod } from "./vod";
import type { XtreamAccount } from "./xtream";

export { DAY, type StoredChannel, type StoredProgramme };

export const DB_NAME = "tiviplayer";
const VERSION = 4;
const STORES = ["imports", "channelLists", "guideChannels", "guide", "vod"];

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

export interface StoredGuideChannel extends GuideChannel {
  source: string;
}

export interface GuideDay {
  source: string;
  /** The guide channel id (a playlist channel's guideId). */
  channel: string;
  /** Days since 1970, UTC, of the programmes' start times. */
  day: number;
  count: number;
  /** The programmes, packed by encodeDay(). */
  data: Uint8Array;
}

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
      db.createObjectStore("guideChannels", { keyPath: ["source", "id"] });
      db.createObjectStore("guide", { keyPath: ["source", "channel", "day"] });
    }
    // Version 4 adds films and series, keeping what version 3 holds; they
    // come with each source's next import.
    if (!db.objectStoreNames.contains("vod")) db.createObjectStore("vod", { keyPath: "source" });
  });
  return request(r);
};

export const deleteDb = (name = DB_NAME) => request<void>(indexedDB.deleteDatabase(name));

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

export const readGuideChannels = (db: IDBDatabase, source: string) =>
  request<StoredGuideChannel[]>(
    db.transaction("guideChannels").objectStore("guideChannels").getAll(sourceRange(source)),
  );

/**
 * A guide channel's programmes that overlap `from`..`to`. It also reads the
 * day before, for programmes that started then and are still on.
 */
export const readGuide = async (
  db: IDBDatabase,
  source: string,
  channel: string,
  from: number,
  to: number,
): Promise<StoredProgramme[]> => {
  const store = db.transaction("guide").objectStore("guide");
  const first = Math.floor(from / DAY) - 1;
  const last = Math.floor(to / DAY);
  const range = IDBKeyRange.bound([source, channel, first], [source, channel, last]);
  const days = await request<GuideDay[]>(store.getAll(range));
  return days.flatMap(day => decodeDay(day.day, day.data).filter(p => p.stop > from && p.start < to));
};

/** Deletes a source's data and import state. */
export const deleteSource = async (db: IDBDatabase, source: string) => {
  const transaction = writeTransaction(db, STORES);
  for (const store of ["guideChannels", "guide"]) {
    transaction.objectStore(store).delete(sourceRange(source));
  }
  transaction.objectStore("channelLists").delete(source);
  transaction.objectStore("vod").delete(source);
  transaction.objectStore("imports").delete(source);
  await finished(transaction);
};
