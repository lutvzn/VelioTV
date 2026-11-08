// Keeps the user's sources and their imports: adding, editing and removing
// sources, and importing them, one at a time, when they are added or
// changed, when asked, and when their data gets old. It checks at startup,
// every quarter of an hour, and whenever the app comes back into view (the
// TV may have been off).
//
// The UI reads it through signals; see sources() and statusOf().

import { createSignal } from "solid-js";
import { ensureAbortController, isAbortError } from "../polyfills/abort";
import { deleteSource, openDb, readImport, readImports, type ImportState } from "./db";
import type { GuideFilter } from "./guideWanted";
import { GUIDE_BUDGET_BYTES, type ImportProgress, type ImportRequest, type ImportResult } from "./importer";
import {
  changesData,
  guideBudget,
  importRequest,
  loadSources,
  newSourceId,
  readSources,
  refreshDue,
  saveSources,
  type Source,
  type SourceDraft,
} from "./sources";

ensureAbortController();

const CHECK_EVERY_MS = 15 * 60_000;
/**
 * Sources removed whose data may not be deleted yet, as the app can close
 * mid-delete. These are deleted at the next start. Data of a source missing
 * from the list is kept unless the settings' copy confirms the list
 * (listConfirmed), as on the TV the list once read as empty at a start
 * (PLAN.md, Phase 5, step 8), and deleting what it didn't name wiped every
 * source's data.
 */
const REMOVED_KEY = "velio.removedSources";

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
  /**
   * Whether the list read at this start is known to be right: the settings'
   * copy in IndexedDB agreed with it, or put it back (src/data/settingsCopy.ts).
   * Only then is the data of sources missing from it deleted.
   */
  listConfirmed?: () => boolean;
  /** The user's hidden channels and groups, whose guides imports leave out. */
  guideFilter?: () => GuideFilter;
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

  // Sources that share a guide (db.ts) count it once, and one that shares
  // this source's guide doesn't count.
  const budgetFor = (id: string) => {
    const own = states()[id]?.guide;
    const guides = new Map<string, number>();
    for (const source of sources()) {
      if (source.id === id || source.disabled) continue;
      const state = states()[source.id];
      const key = state?.guide ?? `\u0000${source.id}`;
      if (key === own) continue;
      guides.set(key, Math.max(guides.get(key) ?? 0, state?.guideBytes ?? 0));
    }
    let othersBytes = 0;
    for (const bytes of guides.values()) othersBytes += bytes;
    return guideBudget(totalBudget, guides.size + 1, othersBytes);
  };

  const run = async (source: Source) => {
    controller = new AbortController();
    setCurrent({ id: source.id });
    try {
      const request = importRequest(source, budgetFor(source.id));
      const filter = options.guideFilter?.();
      if (filter) request.guideFilter = filter;
      await options.importer(request, progress => setCurrent({ id: source.id, progress }), controller.signal);
    } catch (error) {
      // The import state records the failure; the UI shows it from there.
      if (!isAbortError(error)) {
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

  // The removals not finished yet (REMOVED_KEY).
  const pendingRemovals = (): string[] => {
    try {
      const saved: unknown = JSON.parse(options.storage.getItem(REMOVED_KEY) ?? "[]");
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  };
  const setPendingRemovals = (ids: string[]) => {
    try {
      if (ids.length > 0) options.storage.setItem(REMOVED_KEY, JSON.stringify(ids));
      else options.storage.removeItem(REMOVED_KEY);
    } catch (error) {
      console.error("Couldn't save the sources being removed:", error);
    }
  };
  const deleteData = async (id: string) => {
    try {
      await deleteSource(await db(), id);
      setPendingRemovals(pendingRemovals().filter(other => other !== id));
    } catch (error) {
      console.error("Couldn't delete the source's data:", error);
    }
  };

  const remove = async (id: string) => {
    cancel(id);
    setPendingRemovals([...new Set([...pendingRemovals(), id])]);
    save(sources().filter(source => source.id !== id));
    setState(id, undefined);
    await deleteData(id);
  };

  /** Queues every source whose data is old, missing or failed. */
  const check = () => {
    for (const source of sources()) {
      if (source.disabled || current()?.id === source.id) continue;
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
      // Data of a source removed while the app was closing.
      for (const id of pendingRemovals()) {
        if (find(id)) continue;
        setState(id, undefined);
        void deleteData(id);
      }
      // Data of any other source not in the list is kept, unshown, unless the
      // settings' copy confirmed the list (PLAN.md, Phase 8, step 2).
      const unknown = Object.keys(states()).filter(id => !find(id));
      if (unknown.length > 0 && options.listConfirmed?.()) {
        console.warn("Deleting the data of sources not in the list:", unknown);
        for (const id of unknown) {
          setState(id, undefined);
          void deleteData(id);
        }
      } else if (unknown.length > 0) {
        console.warn("Keeping the data of sources not in the list:", unknown);
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
      // The form doesn't edit whether the source is on.
      const next: Source = { ...draft, id };
      if (before.disabled) next.disabled = true;
      else delete next.disabled;
      save(sources().map(source => (source.id === id ? next : source)));
      if (changesData(before, draft)) {
        cancel(id);
        enqueue(id, true);
      }
    },

    remove,

    /** Moves a source `step` places in the order, which is the lineup's. */
    move: (id: string, step: number) => {
      const list = sources().slice();
      const from = list.findIndex(source => source.id === id);
      const to = Math.max(0, Math.min(list.length - 1, from + step));
      if (from < 0 || from === to) return;
      const [source] = list.splice(from, 1);
      list.splice(to, 0, source);
      save(list);
    },

    /** Turns a source off, keeping it and its data, or on again (importing it if due). */
    setDisabled: (id: string, disabled: boolean) => {
      const before = find(id);
      if (!before || Boolean(before.disabled) === disabled) return;
      save(
        sources().map(source => {
          if (source.id !== id) return source;
          const next = { ...source };
          if (disabled) next.disabled = true;
          else delete next.disabled;
          return next;
        }),
      );
      if (disabled) cancel(id);
      else check();
    },

    /**
     * Puts a restored list in place of the sources (PLAN.md, Phase 5,
     * step 7): sources not in it are removed with their data, and the rest
     * import if they're due, as new ones are.
     */
    replaceAll: async (list: unknown) => {
      const next = readSources(list);
      const keep = new Set(next.map(source => source.id));
      const gone = sources().filter(source => !keep.has(source.id));
      save(next);
      await Promise.all(gone.map(source => remove(source.id)));
      check();
      return next;
    },

    /**
     * Imports a source now, or after the import running now; with `again`,
     * once more after it if it is importing now.
     */
    refresh: (id: string, again = false) => enqueue(id, again),

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
