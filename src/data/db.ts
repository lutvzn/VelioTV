// The IndexedDB database that holds imported sources.
//
// Records are keyed by source first. A refresh overwrites a source's records
// in place, then deletes the ones it didn't write: keeping the old import
// beside the new one would need twice the space, and the TV allows each app
// only 80 MB (PLAN.md, Phase 2). If a refresh fails partway, a source has a
// mix of old and new data, which is still usable.
//
// The guide is stored as one record per guide channel per day (UTC), holding
// that day's programmes compressed (guideCodec.ts), written with relaxed
// durability, which was about 20 times faster on the TV than one record per
// programme.

import { DAY, decodeDay, type StoredProgramme } from "./guideCodec";
import type { GuideChannel, PlaylistChannel } from "./types";
import type { XtreamAccount } from "./xtream";

export { DAY, type StoredProgramme };

export const DB_NAME = "tiviplayer";
const VERSION = 2;
const STORES = ["imports", "channels", "guideChannels", "guide"];

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
}

export interface StoredChannel extends PlaylistChannel {
  source: string;
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
  r.addEventListener("upgradeneeded", () => {
    const db = r.result;
    // Version 1 keyed records by import id; nothing in it needs keeping.
    for (const store of Array.from(db.objectStoreNames)) db.deleteObjectStore(store);
    db.createObjectStore("imports", { keyPath: "source" });
    db.createObjectStore("channels", { keyPath: ["source", "index"] });
    db.createObjectStore("guideChannels", { keyPath: ["source", "id"] });
    db.createObjectStore("guide", { keyPath: ["source", "channel", "day"] });
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

export const readChannels = (db: IDBDatabase, source: string) =>
  request<StoredChannel[]>(db.transaction("channels").objectStore("channels").getAll(sourceRange(source)));

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
  for (const store of ["channels", "guideChannels", "guide"]) {
    transaction.objectStore(store).delete(sourceRange(source));
  }
  transaction.objectStore("imports").delete(source);
  await finished(transaction);
};
