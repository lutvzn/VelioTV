// The add-ons the current profile has (PLAN.md, "Stremio add-ons", step 3):
// the account's lists of kind "stremio", each a manifest's address. Their
// manifests are kept in storage, so their catalogs show at once at the next
// start, and are asked for again once a day old or when the address changes.
// Catalog pages, details and subtitles are asked for as they're wanted and
// kept while the app runs; each catalog's first page is also kept in the
// database for 12 hours (catalogSnapshot.ts).
//
// Streams are shown as each add-on answers, in the account's order, and
// kept for 15 minutes, for at most 12 titles, as debrid links stop working
// after a while (after NuvioTVSmart's streamSearchSessionCache.js and
// streamOrdering.js, https://github.com/NuvioMedia/NuvioTVSmart, GPL-3.0;
// changed: rewritten in TypeScript for this app's add-on store).

import { batch, createEffect, createRoot, createSignal, untrack } from "solid-js";
import {
  type CatalogSnapshots,
  isFresh,
  SNAPSHOT_ITEMS,
  type SnapshotPage,
  snapshotRecord,
} from "./catalogSnapshot";
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

/** A title's streams so far, as the add-ons answer. */
export interface StreamSearch {
  /** The answers so far, in the account's order. */
  found: FoundStreams[];
  /** Every add-on has answered. */
  done: boolean;
  /** The add-ons asked, by list id, in the account's order. */
  asked: string[];
  /** Those still to answer. */
  waiting: string[];
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
  /** Where catalogs' first pages are kept between starts (catalogSnapshot.ts). */
  snapshots?: CatalogSnapshots;
}

const STORAGE_KEY = "velio.addons";
const STALE_MS = 24 * 3_600_000;
/** A catalog page asked for again after it failed, at the earliest. */
const RETRY_MS = 60_000;
/** How long a title's streams are kept once every add-on has answered. */
export const STREAMS_KEPT_MS = 15 * 60_000;
/** How long they're kept when an add-on failed, so it's asked again soon. */
const STREAMS_FAILED_KEPT_MS = RETRY_MS;
/** How many titles' streams are kept. */
export const STREAMS_KEPT = 12;
/** First pages are written this long after the last one came, all at once. */
const SNAPSHOT_WRITE_MS = 3000;

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

    const catalogs = (type: string): CatalogGroup[] =>
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

    // Each type's kept first pages are read once, at its first catalog asked
    // for; with them, those catalogs aren't asked until they're 12 hours old.
    const firstPages = new Map<string, Map<string, SnapshotPage>>();
    const firstPagesOf = (type: string) => {
      let found = firstPages.get(type);
      if (!found) firstPages.set(type, (found = new Map()));
      return found;
    };
    const seeded = new Map<string, Promise<void>>();
    const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const firstUrl = (group: CatalogGroup) =>
      catalogUrl(findAddon(group.addon)?.list.url ?? "", group.catalog, { skip: 0 });
    const seed = (type: string) => {
      const snapshots = options.snapshots;
      if (!snapshots) return Promise.resolve();
      let done = seeded.get(type);
      if (!done) {
        done = (async () => {
          const stored = await snapshots.read(type).catch((): SnapshotPage[] => []);
          const at = now();
          const groups = new Map(catalogs(type).map(group => [group.key, group]));
          const shown: Record<string, CatalogPage> = {};
          for (const page of stored) {
            if (!isFresh(page, at) || firstPagesOf(type).has(page.key)) continue;
            firstPagesOf(type).set(page.key, page);
            const group = groups.get(page.key);
            if (group && page.url === firstUrl(group) && page.items.length > 0)
              shown[page.key] = { items: page.items, loading: false, done: page.done };
          }
          setPages(all => {
            const next = { ...all };
            for (const key of Object.keys(shown)) if (!next[key]) next[key] = shown[key];
            return next;
          });
        })();
        seeded.set(type, done);
      }
      return done;
    };
    const writeSoon = (type: string) => {
      const snapshots = options.snapshots;
      if (!snapshots) return;
      clearTimeout(writeTimers.get(type));
      writeTimers.set(
        type,
        setTimeout(() => {
          writeTimers.delete(type);
          const order = catalogs(type).map(group => group.key);
          snapshots
            .write(snapshotRecord(type, [...firstPagesOf(type).values()], order, now()))
            .catch(error => console.warn("Couldn't keep the catalogs' first pages:", error));
        }, SNAPSHOT_WRITE_MS),
      );
    };

    const loadPage = async (group: CatalogGroup) => {
      if (options.snapshots && !seeded.has(group.catalog.type)) {
        await seed(group.catalog.type);
        if (pages()[group.key]) return;
      }
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
        if (skip === 0) {
          firstPagesOf(group.catalog.type).set(group.key, {
            key: group.key,
            url: catalogUrl(state.list.url, group.catalog, { skip: 0 }),
            items: found.slice(0, SNAPSHOT_ITEMS),
            done: !group.catalog.paged || found.length === 0,
            at: now(),
          });
          writeSoon(group.catalog.type);
        }
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
    /** Streams an add-on put in its episodes, by the episode's id, with the add-on. */
    const videoStreams = new Map<string, FoundStreams>();
    const keepVideoStreams = (state: AddonState & { manifest: AddonManifest }, meta: AddonMeta) => {
      for (const video of meta.videos ?? []) {
        if (!video.streams) continue;
        videoStreams.set(video.id, {
          addon: state.list.id,
          addonName: state.manifest.name,
          streams: video.streams,
          unplayable: 0,
          needReferer: 0,
          torrents: video.streams.filter(stream => stream.torrent).length,
        });
      }
    };

    interface Search {
      asked: string[];
      answers: (FoundStreams | undefined)[];
      all: Promise<FoundStreams[]>;
      /** When the last add-on answered. */
      doneAt?: number;
      failed: boolean;
      listeners: Set<(search: StreamSearch) => void>;
    }
    /** By "<type>/<id>", the oldest first. */
    const searches = new Map<string, Search>();
    const snapshot = (search: Search, type: string, id: string): StreamSearch => {
      const found = search.answers.filter((one): one is FoundStreams => one !== undefined);
      const done = search.doneAt !== undefined;
      const { asked } = search;
      const waiting = asked.filter((_, at) => search.answers[at] === undefined);
      // An episode whose streams are in the add-on's meta, when no add-on answered with any.
      const own = videoStreams.get(id);
      if (done && own && type === "series" && !found.some(one => one.streams.length > 0))
        return { found: [...found, own], done, asked, waiting };
      return { found, done, asked, waiting };
    };
    const searchFor = (type: string, id: string) => {
      const key = `${type}/${id}`;
      const had = searches.get(key);
      if (had) {
        const keptMs = had.failed ? STREAMS_FAILED_KEPT_MS : STREAMS_KEPT_MS;
        if (had.doneAt === undefined || now() - had.doneAt < keptMs) {
          // The most recently wanted last, so it's forgotten last.
          searches.delete(key);
          searches.set(key, had);
          return had;
        }
        searches.delete(key);
      }
      const asked = answering("stream", type, id);
      const search: Search = {
        asked: asked.map(state => state.list.id),
        answers: asked.map(() => undefined),
        all: Promise.resolve([]),
        failed: false,
        listeners: new Set(),
      };
      const tell = () => {
        const shown = snapshot(search, type, id);
        search.listeners.forEach(listener => listener(shown));
      };
      search.all = Promise.all(
        asked.map((state, at) =>
          ask(resourceUrl(state.list.url, "stream", type, id))
            .then((value): FoundStreams => ({
              addon: state.list.id,
              addonName: state.manifest.name,
              ...readStreams(value, id),
            }))
            .catch((error: unknown): FoundStreams => {
              search.failed = true;
              return {
                addon: state.list.id,
                addonName: state.manifest.name,
                streams: [],
                unplayable: 0,
                needReferer: 0,
                torrents: 0,
                problem: problemText(error),
              };
            })
            .then(found => {
              search.answers[at] = found;
              // The last answer is told once it's all done, below.
              if (search.answers.some(one => one === undefined)) tell();
              return found;
            }),
        ),
      ).then(() => {
        search.doneAt = now();
        tell();
        return snapshot(search, type, id).found;
      });
      searches.set(key, search);
      for (const old of searches.keys()) {
        if (searches.size <= STREAMS_KEPT) break;
        searches.delete(old);
      }
      return search;
    };
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
        answering(resource, type, id).length > 0 || (resource === "stream" && videoStreams.has(id)),
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
              if (meta) {
                keepVideoStreams(state, meta);
                return meta;
              }
            } catch (error) {
              console.warn(`${state.manifest.name} had no details for ${id}:`, error);
            }
          }
          return undefined;
        }),

      /** Every add-on's streams for a title or an episode, in the account's order, once all have answered. */
      streams: (type: string, id: string) => searchFor(type, id).all,

      /**
       * Tells `listener` a title's streams as each add-on answers, in the
       * account's order: at once with those found so far, then at each
       * answer. Returns what stops it.
       */
      watchStreams: (type: string, id: string, listener: (search: StreamSearch) => void) => {
        const search = searchFor(type, id);
        search.listeners.add(listener);
        listener(snapshot(search, type, id));
        return () => {
          search.listeners.delete(listener);
        };
      },

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
          // What's kept is asked for again too, and kept again as it comes.
          firstPages.clear();
          for (const type of ["movie", "series"]) seeded.set(type, Promise.resolve());
          metas.clear();
          searches.clear();
          videoStreams.clear();
          subtitleCache.clear();
          failedAt.clear();
        }),
    };
  });

export type Addons = ReturnType<typeof createAddons>;
