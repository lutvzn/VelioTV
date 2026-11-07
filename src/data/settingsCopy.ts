// A copy of the app's settings in IndexedDB (PLAN.md, Phase 8, step 1).
//
// The settings (sources, edits, app settings, what was watched, reminders)
// live in localStorage, which reads at once, as the app needs them when it
// starts. Before Phase 8 the app read them as empty or old a few times, at a
// start right after the app was killed; it couldn't be made to happen again
// (the probe runner ran some probes in another page then), but losing the
// sources' list loses their data with it. So every write also goes to a
// small IndexedDB database of its own, with a stamp in both that says when,
// and at each start restoreSettings() puts back the copy into localStorage
// if the copy is newer. The app starts only after that.
//
// All of the app's storage goes through appStorage, so the copy holds
// everything: keys starting "tiviplayer.", apart from probes' own.

const DB_NAME = "tiviplayer-settings";
const STORE = "items";
const PREFIX = "tiviplayer.";
// Keys probes write for themselves (scripts/tv-probe/), which aren't copied.
const UNCOPIED = "tiviplayer.probe.";
/** When the settings were last written, in both. */
export const STAMP_KEY = "tiviplayer.savedAt";
/** How long a start waits for the copy before going on without it. */
const RESTORE_TIMEOUT_MS = 3000;

const isItem = (value: unknown): value is Item =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "key") === "string" &&
  typeof Reflect.get(value, "value") === "string";

const copied = (key: string) => key.startsWith(PREFIX) && !key.startsWith(UNCOPIED);

interface Item {
  key: string;
  value: string;
}

/** What the last start did with the copy, for probes. */
export interface RestoreResult {
  action: "same" | "seeded" | "restored" | "recopied" | "failed" | "timedOut";
  /** The stamps found, in localStorage and in the copy. */
  local: number;
  copy: number;
  /** Keys put back from the copy. */
  keys?: number;
  /** How long it held up the start. */
  ms?: number;
  error?: string;
}

const completed = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Transaction failed")));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Transaction aborted")),
    );
  });

const openCopy = (name: string) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.addEventListener("upgradeneeded", () => r.result.createObjectStore(STORE, { keyPath: "key" }));
    r.addEventListener("success", () => resolve(r.result));
    r.addEventListener("error", () => reject(r.error ?? new Error("Couldn't open the settings copy")));
    r.addEventListener("blocked", () => reject(new Error("The settings copy is blocked")));
  });

const readStamp = (value: string | null | undefined) => {
  const stamp = Number(value);
  return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
};

export interface SettingsCopy {
  /** localStorage, writing through to the copy. */
  storage: Storage;
  /** Brings localStorage and the copy level; call before anything reads storage. */
  restore(): Promise<RestoreResult>;
  /** Resolves once the writes so far are in the copy (for tests and probes). */
  flushed(): Promise<void>;
  lastRestore(): RestoreResult | undefined;
}

export const createSettingsCopy = (local: Storage, name = DB_NAME): SettingsCopy => {
  let db: Promise<IDBDatabase> | undefined;
  const database = () => (db ??= openCopy(name));
  let last: RestoreResult | undefined;
  // Once a start has gone on without the copy, it mustn't change localStorage under it.
  let gaveUp = false;
  // Writes go to the copy in order, one transaction each.
  let queue = Promise.resolve();
  const writeNow = async (change: (store: IDBObjectStore) => void) => {
    const transaction = (await database()).transaction(STORE, "readwrite", { durability: "strict" });
    change(transaction.objectStore(STORE));
    await completed(transaction);
  };
  const write = (change: (store: IDBObjectStore) => void) => {
    queue = queue
      .then(() => writeNow(change))
      .catch(error => console.error("Couldn't write the settings copy:", error));
  };
  // A stamp later than any before, even if the clock went back.
  const nextStamp = () => Math.max(Date.now(), readStamp(local.getItem(STAMP_KEY)) + 1);

  const localItems = () => {
    const items: Item[] = [];
    for (let i = 0; i < local.length; i++) {
      const key = local.key(i);
      if (key !== null && copied(key)) items.push({ key, value: local.getItem(key) ?? "" });
    }
    return items;
  };
  /** Replaces the whole copy with what localStorage holds. */
  const copyAll = () => {
    const items = localItems();
    write(store => {
      store.clear();
      for (const item of items) store.put(item);
    });
  };

  const storage: Storage = {
    get length() {
      return local.length;
    },
    clear: () => {
      for (const item of localItems()) local.removeItem(item.key);
      local.setItem(STAMP_KEY, String(nextStamp()));
      copyAll();
    },
    getItem: key => local.getItem(key),
    key: index => local.key(index),
    removeItem: key => {
      local.removeItem(key);
      if (!copied(key)) return;
      const stamp = String(nextStamp());
      local.setItem(STAMP_KEY, stamp);
      write(store => {
        store.delete(key);
        store.put({ key: STAMP_KEY, value: stamp });
      });
    },
    setItem: (key, value) => {
      // A full localStorage throws here, before anything is copied.
      local.setItem(key, value);
      if (!copied(key)) return;
      const stamp = String(nextStamp());
      local.setItem(STAMP_KEY, stamp);
      write(store => {
        store.put({ key, value });
        store.put({ key: STAMP_KEY, value: stamp });
      });
    },
  };

  const restoreNow = async (): Promise<RestoreResult> => {
    const transaction = (await database()).transaction(STORE, "readonly");
    const items = await new Promise<Item[]>((resolve, reject) => {
      const r = transaction.objectStore(STORE).getAll();
      r.addEventListener("success", () => resolve((r.result as unknown[]).filter(isItem)));
      r.addEventListener("error", () => reject(r.error ?? new Error("Couldn't read the settings copy")));
    });
    const copyStamp = readStamp(items.find(item => item.key === STAMP_KEY)?.value);
    const localStamp = readStamp(local.getItem(STAMP_KEY));
    // No copy yet (the first start with one), or localStorage is newer: the
    // copy follows localStorage. Before Phase 8 nothing wrote a stamp.
    if (!gaveUp && (copyStamp === 0 || localStamp > copyStamp)) {
      if (localStamp === 0) local.setItem(STAMP_KEY, String(nextStamp()));
      copyAll();
      await queue;
      return { action: copyStamp === 0 ? "seeded" : "recopied", local: localStamp, copy: copyStamp };
    }
    if (gaveUp) return { action: "timedOut", local: localStamp, copy: copyStamp };
    if (localStamp === copyStamp) return { action: "same", local: localStamp, copy: copyStamp };
    // The copy is newer: localStorage lost writes, or reads as empty.
    for (const item of localItems()) local.removeItem(item.key);
    for (const item of items) local.setItem(item.key, item.value);
    console.warn(`Settings put back from their copy: ${items.length} keys, ${localStamp} < ${copyStamp}`);
    return { action: "restored", local: localStamp, copy: copyStamp, keys: items.length - 1 };
  };

  return {
    storage,
    restore: async () => {
      const local0 = readStamp(local.getItem(STAMP_KEY));
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<RestoreResult>(resolve => {
        timer = setTimeout(() => {
          gaveUp = true;
          resolve({ action: "timedOut", local: local0, copy: 0 });
        }, RESTORE_TIMEOUT_MS);
      });
      last = await Promise.race([
        restoreNow().catch((error: unknown): RestoreResult => ({
          action: "failed",
          local: local0,
          copy: 0,
          error: error instanceof Error ? error.message : String(error),
        })),
        timeout,
      ]);
      clearTimeout(timer);
      last = { ...last, ms: Math.round(performance.now() - started) };
      return last;
    },
    flushed: () => queue,
    lastRestore: () => last,
  };
};

/** The app's settings storage: localStorage, copied to IndexedDB. */
export const settingsCopy = createSettingsCopy(localStorage);
export const appStorage = settingsCopy.storage;
