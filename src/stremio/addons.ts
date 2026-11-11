// The add-ons the current profile has (PLAN.md, "Stremio add-ons", step 3):
// the account's lists of kind "stremio", each a manifest's address. Their
// manifests are kept in storage, so their catalogs show at once at the next
// start, and are asked for again once a day old or when the address changes.
// Catalog pages, details, streams and subtitles are asked for as they're
// wanted and kept while the app runs.

import { batch, createEffect, createRoot, createSignal, untrack } from "solid-js";
import {
  catalogUrl,
  getJson,
  hasCatalogs,
  readCatalog,
  readManifest,
  readMetaAnswer,
  readStreams,
  readSubtitlesAnswer,
  resourceUrl,
  supports,
  type AddonCatalog,
  type AddonManifest,
  type AddonMeta,
  type AddonResource,
  type AddonSubtitle,
  type StreamsRead,
} from "./addon";

/** An add-on as the account gives it. */
export interface AddonList {
  /** The list's id in the account. */
  id: string;
  name: string;
  url: string;
}

export interface AddonState {
  list: AddonList;
  manifest?: AddonManifest;
  /** When the manifest was last read. */
  fetchedAt?: number;
  /** Why the manifest couldn't be read, the last time it was asked for. */
  problem?: string;
  loading: boolean;
}

/** The kinds of title the app shows: Stremio's "movie" and "series". */
export type TitleType = "movie" | "series";

export interface CatalogGroup {
  /** "<list id>/<type>/<catalog id>" */
  key: string;
  addon: string;
  /** The add-on's name. */
  addonName: string;
  catalog: AddonCatalog;
}

export interface CatalogPage {
  items: AddonMeta[];
  loading: boolean;
  /** No more to ask for. */
  done: boolean;
  problem?: string;
}

/** A title found by an add-on, with which add-on found it. */
export interface FoundMeta extends AddonMeta {
  addon: string;
}

export interface FoundStreams extends StreamsRead {
  addon: string;
  addonName: string;
  problem?: string;
}

export interface FoundSubtitle extends AddonSubtitle {
  addonName: string;
}

export interface AddonsOptions {
  lists: () => AddonList[];
  storage: Pick<Storage, "getItem" | "setItem">;
  /** Where the manifests are kept; "velio.addons" by default. */
  storageKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long a page of a catalog can take. */
  timeoutMs?: number;
}

const STORAGE_KEY = "velio.addons";
const STALE_MS = 24 * 3_600_000;
/** A catalog page asked for again after it failed, at the earliest. */
const RETRY_MS = 60_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

interface Kept {
  /** The manifest as the add-on sent it, which is what's stored, and read again at each start. */
  raw: unknown;
  manifest: AddonManifest;
  fetchedAt: number;
}

/** The kept manifests, by address. */
const loadKept = (storage: AddonsOptions["storage"], storageKey: string) => {
  const kept = new Map<string, Kept>();
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey) ?? "{}");
    if (!isObject(value)) return kept;
    for (const url of Object.keys(value)) {
      const entry = value[url];
      if (!isObject(entry) || typeof entry.fetchedAt !== "number") continue;
      try {
        kept.set(url, { raw: entry.raw, manifest: readManifest(entry.raw), fetchedAt: entry.fetchedAt });
      } catch {
        // One that no longer reads is asked for again.
      }
    }
  } catch {
    // Nothing kept, or not readable: they're all asked for.
  }
  return kept;
};

/** Keeps a request's answer, or forgets it if it failed, so it's asked again. */
const cached = <T>(cache: Map<string, Promise<T>>, key: string, ask: () => Promise<T>) => {
  let found = cache.get(key);
  if (!found) {
    found = ask();
    cache.set(key, found);
    found.catch(() => cache.delete(key));
  }
  return found;
};

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createAddons = (options: AddonsOptions) =>
  createRoot(() => {
    const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const now = options.now ?? (() => Date.now());
    const ask = (url: string) => getJson(url, fetcher, options.timeoutMs);
    const storageKey = options.storageKey ?? STORAGE_KEY;
    const kept = loadKept(options.storage, storageKey);
    const save = () => {
      const value: Record<string, unknown> = {};
      // Only the add-ons the TV still has.
      const wanted = new Set(options.lists().map(list => list.url));
      for (const [url, entry] of kept)
        if (wanted.has(url)) value[url] = { raw: entry.raw, fetchedAt: entry.fetchedAt };
      try {
        options.storage.setItem(storageKey, JSON.stringify(value));
      } catch (error) {
        console.warn("Couldn't keep the add-ons' manifests:", error);
      }
    };

    const [states, setStates] = createSignal<Record<string, AddonState>>({});
    const asking = new Map<string, Promise<void>>();

    const fetchManifest = (list: AddonList) => {
      const running = asking.get(list.url);
      if (running) return running;
      setStates(all => ({ ...all, [list.id]: { ...(all[list.id] ?? { list }), list, loading: true } }));
      const read = async () => {
        try {
          const raw = await ask(list.url);
          const manifest = readManifest(raw);
          const fetchedAt = now();
          kept.set(list.url, { raw, manifest, fetchedAt });
          save();
          setStates(all => ({ ...all, [list.id]: { list, manifest, fetchedAt, loading: false } }));
        } catch (error) {
          console.warn(`Couldn't read the add-on ${list.name}:`, error);
          setStates(all => ({
            ...all,
            // A manifest kept from before is still used.
            [list.id]: { ...all[list.id], list, problem: problemText(error), loading: false },
          }));
        } finally {
          asking.delete(list.url);
        }
      };
      const done = read();
      asking.set(list.url, done);
      return done;
    };

    // The lists as they come and go: kept manifests at once, then asked for again if old.
    createEffect(() => {
      const lists = options.lists();
      // Not tracked: the effect sets them.
      const before = untrack(states);
      const next: Record<string, AddonState> = {};
      const stale: AddonList[] = [];
      for (const list of lists) {
        const was = before[list.id];
        if (was && was.list.url === list.url) {
          next[list.id] = { ...was, list };
          continue;
        }
        const found = kept.get(list.url);
        next[list.id] = { list, manifest: found?.manifest, fetchedAt: found?.fetchedAt, loading: false };
        if (!found || now() - found.fetchedAt > STALE_MS) stale.push(list);
      }
      setStates(next);
      untrack(() => {
        for (const list of stale) void fetchManifest(list);
      });
    });

    const ordered = () => {
      const all = states();
      return options.lists().flatMap(list => (all[list.id] ? [all[list.id]] : []));
    };
    /** The add-ons with a manifest, in the account's order. */
    const ready = () =>
      ordered().filter((state): state is AddonState & { manifest: AddonManifest } => !!state.manifest);
    const findAddon = (id: string) => ready().find(state => state.list.id === id);

    const catalogs = (type: TitleType): CatalogGroup[] =>
      ready().flatMap(state =>
        hasCatalogs(state.manifest)
          ? state.manifest.catalogs
              .filter(catalog => catalog.type === type && !catalog.searchOnly)
              .map(catalog => ({
                key: `${state.list.id}/${catalog.type}/${catalog.id}`,
                addon: state.list.id,
                addonName: state.manifest.name,
                catalog,
              }))
          : [],
      );

    const [pages, setPages] = createSignal<Record<string, CatalogPage>>({});
    const failedAt = new Map<string, number>();
    const loadPage = async (group: CatalogGroup) => {
      const page = pages()[group.key];
      if (page?.loading || page?.done) return;
      const failed = failedAt.get(group.key);
      if (failed !== undefined && now() - failed < RETRY_MS) return;
      const state = findAddon(group.addon);
      if (!state) return;
      const have = page?.items ?? [];
      setPages(all => ({ ...all, [group.key]: { items: have, loading: true, done: false } }));
      try {
        const skip = have.length;
        if (skip > 0 && !group.catalog.paged) {
          setPages(all => ({ ...all, [group.key]: { items: have, loading: false, done: true } }));
          return;
        }
        const found = readCatalog(
          await ask(catalogUrl(state.list.url, group.catalog, { skip })),
          group.catalog.type,
        );
        failedAt.delete(group.key);
        const known = new Set(have.map(item => item.id));
        const added = found.filter(item => !known.has(item.id));
        setPages(all => ({
          ...all,
          [group.key]: {
            items: [...have, ...added],
            loading: false,
            // An add-on that pages sends an empty page at the end; one that
            // doesn't, or that sent the same titles again, has no more.
            done: !group.catalog.paged || added.length === 0,
          },
        }));
      } catch (error) {
        failedAt.set(group.key, now());
        setPages(all => ({
          ...all,
          [group.key]: { items: have, loading: false, done: false, problem: problemText(error) },
        }));
      }
    };

    const metas = new Map<string, Promise<AddonMeta | undefined>>();
    const streamCache = new Map<string, Promise<FoundStreams[]>>();
    const subtitleCache = new Map<string, Promise<FoundSubtitle[]>>();

    /** The add-ons that answer `resource` for this title, `first` first. */
    const answering = (resource: AddonResource, type: string, id: string, first?: string) => {
      const found = ready().filter(state => supports(state.manifest, resource, type, id));
      const preferred = found.filter(state => state.list.id === first);
      return [...preferred, ...found.filter(state => state.list.id !== first)];
    };

    return {
      /** Each add-on, in the account's order, with its manifest once read. */
      states: ordered,
      /** The catalogs of films or series, in the account's order, then each add-on's. */
      catalogs,
      /** The titles loaded so far in each catalog, by its key. */
      pages,
      /** Asks for a catalog's first page, or its next, unless it's loading or has no more. */
      loadPage,
      /** Whether any add-on answers `resource` for this title, such as streams. */
      answers: (resource: AddonResource, type: string, id: string) =>
        answering(resource, type, id).length > 0,
      /** Asks every add-on for its manifest again. */
      refresh: () => Promise.all(options.lists().map(fetchManifest)).then(() => undefined),

      /** Titles from the add-ons that can search; each add-on's, in order. */
      search: async (type: TitleType, query: string): Promise<FoundMeta[]> => {
        const asked = ready().flatMap(state =>
          hasCatalogs(state.manifest)
            ? state.manifest.catalogs
                .filter(catalog => catalog.type === type && catalog.search)
                .map(catalog =>
                  ask(catalogUrl(state.list.url, catalog, { search: query }))
                    .then(value => readCatalog(value, type).map(meta => ({ ...meta, addon: state.list.id })))
                    .catch((error: unknown) => {
                      console.warn(`${state.manifest.name} couldn't search:`, error);
                      return [] as FoundMeta[];
                    }),
                )
            : [],
        );
        const seen = new Set<string>();
        return (await Promise.all(asked)).flat().filter(meta => {
          if (seen.has(meta.id)) return false;
          seen.add(meta.id);
          return true;
        });
      },

      /** Like search(), but an add-on that can't be asked fails it, so it can be asked again later. */
      searchOrFail: async (type: TitleType, query: string): Promise<FoundMeta[]> => {
        const asked = ready().flatMap(state =>
          hasCatalogs(state.manifest)
            ? state.manifest.catalogs
                .filter(catalog => catalog.type === type && catalog.search)
                .map(async catalog =>
                  readCatalog(await ask(catalogUrl(state.list.url, catalog, { search: query })), type).map(
                    meta => ({ ...meta, addon: state.list.id }),
                  ),
                )
            : [],
        );
        if (asked.length === 0) throw new Error("No add-on can search");
        return (await Promise.all(asked)).flat();
      },

      /** A title's details, from the first add-on with metas for it (`first` before the rest). */
      meta: (type: string, id: string, first?: string) =>
        cached(metas, `${type}/${id}`, async () => {
          for (const state of answering("meta", type, id, first)) {
            try {
              const meta = readMetaAnswer(await ask(resourceUrl(state.list.url, "meta", type, id)), type);
              if (meta) return meta;
            } catch (error) {
              console.warn(`${state.manifest.name} had no details for ${id}:`, error);
            }
          }
          return undefined;
        }),

      /** Every add-on's streams for a title or an episode, in the account's order. */
      streams: (type: string, id: string) =>
        cached(streamCache, `${type}/${id}`, () =>
          Promise.all(
            answering("stream", type, id).map(state =>
              ask(resourceUrl(state.list.url, "stream", type, id))
                .then((value): FoundStreams => ({
                  addon: state.list.id,
                  addonName: state.manifest.name,
                  ...readStreams(value),
                }))
                .catch((error: unknown): FoundStreams => ({
                  addon: state.list.id,
                  addonName: state.manifest.name,
                  streams: [],
                  unplayable: 0,
                  needReferer: 0,
                  problem: problemText(error),
                })),
            ),
          ),
        ),

      /** Every add-on's subtitles for a title or an episode. */
      subtitles: (type: string, id: string) =>
        cached(subtitleCache, `${type}/${id}`, async () => {
          const found = await Promise.all(
            answering("subtitles", type, id).map(state =>
              ask(resourceUrl(state.list.url, "subtitles", type, id))
                .then(value =>
                  readSubtitlesAnswer(value).map(subtitle => ({
                    ...subtitle,
                    addonName: state.manifest.name,
                  })),
                )
                .catch(() => [] as FoundSubtitle[]),
            ),
          );
          return found.flat();
        }),

      /** Forgets the catalogs, details and streams asked for, so they're asked again. */
      forget: () =>
        batch(() => {
          setPages({});
          metas.clear();
          streamCache.clear();
          subtitleCache.clear();
          failedAt.clear();
        }),
    };
  });

export type Addons = ReturnType<typeof createAddons>;
