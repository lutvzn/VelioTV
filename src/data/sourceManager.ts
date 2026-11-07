// Keeps the user's sources and their imports: adding, editing and removing
// sources, and importing them, one at a time, when they are added or
// changed, when asked, and when their data gets old. It checks at startup,
// every quarter of an hour, and whenever the app comes back into view (the
// TV may have been off).
//
// The UI reads it through signals; see sources() and statusOf().

import { createSignal } from "solid-js";
import { deleteSource, openDb, readImport, readImports, type ImportState } from "./db";
import { GUIDE_BUDGET_BYTES, type ImportProgress, type ImportRequest, type ImportResult } from "./importer";
import {
  changesData,
  guideBudget,
  importRequest,
  loadSources,
  newSourceId,
  refreshDue,
  saveSources,
  type Source,
  type SourceDraft,
} from "./sources";

const CHECK_EVERY_MS = 15 * 60_000;

export type Importer = (
  request: ImportRequest,
  onProgress: (progress: ImportProgress) => void,
  signal: AbortSignal,
) => Promise<ImportResult>;

export interface SourceStatus {
  /** The last import's state, as stored. */
  state?: ImportState;
  /** Set while the source is importing. */
  progress?: ImportProgress;
  importing: boolean;
  /** Waiting for another source's import to finish. */
  queued: boolean;
}

export interface SourceManagerOptions {
  importer: Importer;
  storage: Storage;
  dbName?: string;
  now?: () => number;
  /** The guide's storage budget for all sources together. */
  guideBudgetBytes?: number;
}

export const createSourceManager = (options: SourceManagerOptions) => {
  const now = options.now ?? Date.now;
  const totalBudget = options.guideBudgetBytes ?? GUIDE_BUDGET_BYTES;
  const [sources, setSources] = createSignal<Source[]>(loadSources(options.storage));
  const [states, setStates] = createSignal<Record<string, ImportState>>({});
  const [loaded, setLoaded] = createSignal(false);
  const [queue, setQueue] = createSignal<string[]>([]);
  const [current, setCurrent] = createSignal<{ id: string; progress?: ImportProgress }>();
  let controller: AbortController | undefined;
  // Runs while the queue has sources in it.
  let draining: Promise<void> | undefined;
  let dbPromise: Promise<IDBDatabase> | undefined;
  const db = () => (dbPromise ??= openDb(options.dbName));

  const save = (list: Source[]) => {
    setSources(list);
    try {
      saveSources(options.storage, list);
    } catch (error) {
      console.error("Couldn't save the sources:", error);
    }
  };
  const find = (id: string) => sources().find(source => source.id === id);

  const setState = (id: string, state: ImportState | undefined) =>
    setStates(all => {
      const next = { ...all };
      if (state) next[id] = state;
      else delete next[id];
      return next;
    });
  const reloadState = async (id: string) => {
    try {
      setState(id, await readImport(await db(), id));
    } catch (error) {
      console.error("Couldn't read the import state:", error);
    }
  };

  const budgetFor = (id: string) => {
    const others = sources().filter(source => source.id !== id);
    const othersBytes = others.reduce((sum, source) => sum + (states()[source.id]?.guideBytes ?? 0), 0);
    return guideBudget(totalBudget, others.length + 1, othersBytes);
  };

  const run = async (source: Source) => {
    controller = new AbortController();
    setCurrent({ id: source.id });
    try {
      await options.importer(
        importRequest(source, budgetFor(source.id)),
        progress => setCurrent({ id: source.id, progress }),
        controller.signal,
      );
    } catch (error) {
      // The import state records the failure; the UI shows it from there.
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.warn(`Importing ${source.name} failed:`, error);
      }
    }
    controller = undefined;
    // Unless it was removed meanwhile.
    if (find(source.id)) await reloadState(source.id);
    setCurrent(undefined);
  };

  const drain = async () => {
    while (queue().length > 0) {
      const [id, ...rest] = queue();
      setQueue(rest);
      const source = find(id);
      if (source) await run(source);
    }
  };

  // Waits for the queue to empty; imports queued meanwhile run too.
  const settled = async () => {
    for (let running = draining; running; running = draining) await running;
  };

  /** Queues an import, unless one is waiting, or running when `again` is false. */
  const enqueue = (id: string, again = false) => {
    if (queue().includes(id) || (!again && current()?.id === id)) return;
    setQueue(list => [...list, id]);
    draining ??= drain().finally(() => (draining = undefined));
  };

  // Stops a source's import, if it's running or waiting.
  const cancel = (id: string) => {
    setQueue(list => list.filter(queued => queued !== id));
    if (current()?.id === id) controller?.abort();
  };

  /** Queues every source whose data is old, missing or failed. */
  const check = () => {
    for (const source of sources()) {
      if (current()?.id === source.id) continue;
      if (refreshDue(source, states()[source.id], now())) enqueue(source.id);
    }
  };

  return {
    sources,

    /** True once `start` has read the import states, so the lineup knows which sources have channels. */
    loaded,

    statusOf: (id: string): SourceStatus => {
      const running = current();
      return {
        state: states()[id],
        progress: running?.id === id ? running.progress : undefined,
        importing: running?.id === id,
        queued: queue().includes(id),
      };
    },

    /** The source importing now, and how far it has got. */
    importing: () => {
      const running = current();
      return running && { source: find(running.id), progress: running.progress };
    },

    /** Reads the import states, then checks now and on a schedule. Returns a stop function. */
    start: async () => {
      try {
        const all = await readImports(await db());
        setStates(Object.fromEntries(all.map(state => [state.source, state])));
      } catch (error) {
        console.error("Couldn't read the import states:", error);
      } finally {
        setLoaded(true);
      }
      // Data left by a source removed while the app was closing.
      for (const id of Object.keys(states())) {
        if (!find(id)) {
          setState(id, undefined);
          void db()
            .then(database => deleteSource(database, id))
            .catch((error: unknown) => console.error("Couldn't delete a removed source's data:", error));
        }
      }
      check();
      const timer = setInterval(check, CHECK_EVERY_MS);
      const onVisible = () => {
        if (document.visibilityState === "visible") check();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },

    check,

    add: (draft: SourceDraft) => {
      const source: Source = { ...draft, id: newSourceId() };
      save([...sources(), source]);
      enqueue(source.id);
      return source;
    },

    /** Saves a source's settings, and imports it again if they change its data. */
    update: (id: string, draft: SourceDraft) => {
      const before = find(id);
      if (!before) return;
      save(sources().map(source => (source.id === id ? { ...draft, id } : source)));
      if (changesData(before, draft)) {
        cancel(id);
        enqueue(id, true);
      }
    },

    remove: async (id: string) => {
      cancel(id);
      save(sources().filter(source => source.id !== id));
      setState(id, undefined);
      try {
        await deleteSource(await db(), id);
      } catch (error) {
        console.error("Couldn't delete the source's data:", error);
      }
    },

    /** Imports a source now, or after the import running now. */
    refresh: (id: string) => enqueue(id),

    /** Resolves when no import is running or waiting. */
    whenIdle: settled,

    close: async () => {
      setQueue([]);
      controller?.abort();
      await settled();
      if (dbPromise) (await dbPromise).close();
      dbPromise = undefined;
    },
  };
};

export type SourceManager = ReturnType<typeof createSourceManager>;
