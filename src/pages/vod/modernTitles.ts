// The modern Movies and Series pages' titles and groups (PLAN.md, "Movies
// and Series by title", step 4): every source's copy of a title and the
// add-ons' as one (src/data/titles.ts), then Popular, from Cinemeta, the
// genres, most titles first, the add-ons' catalogs, and last the provider
// categories: of the titles Cinemeta doesn't have, or of every title, as
// Settings has it (src/data/vodLayout.ts). A title is in the category of
// each of its copies. While titles are being matched, the genres keep the
// order they had, so the column doesn't shift as matches come in; new ones
// go last, and the order is made again once matching ends. New matches wait
// while keys are being pressed, so a page being moved through doesn't
// stop to show them.

import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import {
  createFilmMerger,
  createSeriesMerger,
  type AddonItem,
  type Merger,
  type Titles,
} from "../../data/titles";
import type { FilmEntry, SeriesEntry } from "../../data/vodLibrary";
import { addons, cinemeta, library, titleMatcher, vod, vodLayout } from "../../library";
import type { FileQuality } from "../../data/vod";
import type { TitleType } from "../../stremio/addons";
import { heightOf } from "../../stremio/streamText";
import { $t, warmFormats } from "../../translate";
import { useAddonGroups } from "./addonGroups";
import type { PickerLink } from "./StreamPicker";
import type { ExtraGroup } from "./VodHub";

/** Popular's pages asked for at most, while too few of its titles can be played. */
const POPULAR_PAGES = 8;
/** Popular asks for more until it has this many. */
const POPULAR_WANTED = 40;
/** How long after the last key new matches are shown. */
export const QUIET_MS = 1500;

/** When a key was last pressed, from anywhere in the app. */
let lastKeyAt = -Infinity;
if (typeof document !== "undefined")
  document.addEventListener("keydown", () => (lastKeyAt = performance.now()), true);

/** The matcher's version, but held while keys are being pressed. */
const useQuietVersion = () => {
  const [shown, setShown] = createSignal(untrack(titleMatcher.version));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = () => {
    timer = undefined;
    const wait = lastKeyAt + QUIET_MS - performance.now();
    if (wait > 0) timer = setTimeout(show, wait);
    else setShown(titleMatcher.version());
  };
  createEffect(() => {
    titleMatcher.version();
    timer ??= setTimeout(show, 0);
  });
  onCleanup(() => clearTimeout(timer));
  return shown;
};

/**
 * Each kind's merger, kept from one visit to the next: it joins again only
 * what changed since (src/data/titles.ts), so opening Movies again doesn't
 * join every film anew (over a second on the TV with 36,000 films; PLAN.md,
 * "Navigation speed").
 */
const mergers = new Map<TitleType, unknown>();
/** The add-ons' items each kind's page last joined, which warming joins again. */
const lastItems = new Map<TitleType, readonly AddonItem[]>();
/** The kinds whose page is open, which warming leaves to the page. */
const open = new Map<TitleType, number>();

const mergerOf = <E extends FilmEntry | SeriesEntry, T extends Merged<E>>(
  type: TitleType,
  create: () => Merger<E, T>,
) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const found = (mergers.get(type) as Merger<E, T> | undefined) ?? create();
  mergers.set(type, found);
  return found;
};

/** How long after the last key the titles are joined in the background. */
const WARM_QUIET_MS = 2000;
let warmTimer: ReturnType<typeof setTimeout> | undefined;
/** What each kind was last warmed with, so the same isn't joined twice. */
const warmedWith = new Map<TitleType, { entries: readonly unknown[]; id: number; at: number }>();

/** Joins one kind's titles, unless its page is open or nothing changed; whether it did. */
const warm = <E extends FilmEntry | SeriesEntry, T extends Merged<E>>(
  type: TitleType,
  entries: readonly E[],
  create: () => Merger<E, T>,
) => {
  if (entries.length === 0 || open.get(type)) return false;
  const changes = titleMatcher.changes();
  const last = warmedWith.get(type);
  if (last?.entries === entries && last.id === changes.id && last.at === changes.keys.length) return false;
  mergerOf(type, create)(entries, titleMatcher.matchOf, lastItems.get(type) ?? [], changes);
  warmedWith.set(type, { entries, id: changes.id, at: changes.keys.length });
  return true;
};

const warmNow = () => {
  warmTimer = undefined;
  const wait = lastKeyAt + WARM_QUIET_MS - performance.now();
  if (wait > 0) {
    warmTimer = setTimeout(warmNow, wait);
    return;
  }
  // One at a time, so a key pressed meanwhile waits for one only.
  const did =
    warmFormats() ||
    warm("movie", untrack(vod.films), createFilmMerger) ||
    warm("series", untrack(vod.series), createSeriesMerger);
  if (did) warmTimer = setTimeout(warmNow, 0);
};

/**
 * Joins the films and series in the background once no key has been
 * pressed for a while, so opening Movies or Series only joins what changed
 * since (PLAN.md, "Navigation speed"). Called again as they or their
 * matches change.
 */
export const warmTitlesLater = () => {
  warmTimer ??= setTimeout(warmNow, WARM_QUIET_MS);
};

/** The genre and category groups as last made, by kind, to give again while their titles are the same. */
interface Sorted<T> {
  all: readonly T[];
  every: boolean;
  categories: readonly string[];
  matching: boolean;
  /** The genres' order, kept while matching goes on. */
  genreOrder: string[];
  genres: ExtraGroup<T>[];
  categoryGroups: ExtraGroup<T>[];
}
const sortedGroups = new Map<TitleType, unknown>();

type Merged<E> = E & { links: E[]; genres: string[]; imdb?: string; progress?: number };

export interface ModernOptions<E extends FilmEntry | SeriesEntry, T extends Merged<E>> {
  type: TitleType;
  entries: () => readonly E[];
  /** The providers' categories, in order. */
  categories: () => string[];
  merge: (
    entries: readonly E[],
    matchOf: typeof titleMatcher.matchOf,
    items: readonly AddonItem[],
  ) => Titles<T>;
  /** merge(), as one that joins again only what changed (src/data/titles.ts). */
  createMerger: () => Merger<E, T>;
  /** filmKey or seriesKey (src/stremio/vodEntries.ts). */
  keyOf: (id: string) => string;
  /** How far titles were watched, by their keys. */
  progress?: () => ReadonlyMap<string, number>;
}

const KINDS: Record<string, string> = { m3u8: "HLS", mpd: "DASH", ts: "TS" };

/** What kind of file a link is, from its address, such as "MKV". */
export const fileKind = (url: string) => {
  const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  return ext ? (KINDS[ext] ?? ext.toUpperCase()) : "";
};

/**
 * A title's copy from a source, as the picker's row: the source, the
 * provider's name, the kind of file, and its picture's height from what
 * `known` gives or else the name and group ("Film 4K", "VOD | FHD").
 */
export const linkRow = <L>(
  link: L,
  source: string,
  name: string,
  url: string,
  category?: string,
  known: FileQuality = {},
): PickerLink<L> => {
  const from = library.sources().find(one => one.id === source)?.name ?? source;
  const height = known.height ?? heightOf([name, category ?? ""]);
  return {
    link,
    text: `${from} · ${name}`,
    detail: [fileKind(url), category].filter(Boolean).join("   ·   "),
    quality: { height, estimatedBytes: known.estimatedBytes },
  };
};

export const useModernTitles = <E extends FilmEntry | SeriesEntry, T extends Merged<E>>(
  options: ModernOptions<E, T>,
) => {
  const fromAddons = useAddonGroups(options.type, (meta, addon): AddonItem & { key: string } => ({
    meta,
    addon,
    key: `${addon}/${meta.id}`,
  }));

  // Popular is Cinemeta's first catalog.
  const popular = createMemo(() => cinemeta.catalogs(options.type)[0]);
  const popularPage = () => {
    const group = popular();
    return group ? cinemeta.pages()[group.key] : undefined;
  };
  let popularAsked = 0;
  const morePopular = () => {
    const group = popular();
    if (!group || popularAsked >= POPULAR_PAGES) return;
    popularAsked++;
    void cinemeta.loadPage(group);
  };
  createEffect(() => {
    if (popular() && !popularPage()) morePopular();
  });

  const joined = mergerOf(options.type, options.createMerger);
  open.set(options.type, (open.get(options.type) ?? 0) + 1);
  onCleanup(() => {
    open.set(options.type, (open.get(options.type) ?? 1) - 1);
    // What changed while it was open is joined before the next visit.
    warmTitlesLater();
  });
  const version = useQuietVersion();
  const titles = createMemo(() => {
    const items: AddonItem[] = [];
    for (const group of fromAddons.extraGroups()) items.push(...group.items);
    // Popular titles no source has join only if an add-on has streams for them.
    for (const meta of popularPage()?.items ?? [])
      if (addons.answers("stream", options.type, meta.id)) items.push({ meta, addon: "" });
    // Once: matchOf() isn't tracked, as it's asked for every title.
    version();
    lastItems.set(options.type, items);
    const merged = joined(options.entries(), titleMatcher.matchOf, items, titleMatcher.changes());
    // The few watched, not every title.
    for (const [key, part] of options.progress?.() ?? []) {
      const title = merged.byKey.get(key);
      if (title?.key === key) title.progress = part;
    }
    return merged;
  });

  const popularTitles = createMemo(() => {
    const { byKey } = titles();
    const seen = new Set<T>();
    for (const meta of popularPage()?.items ?? []) {
      const title = byKey.get(options.keyOf(meta.id));
      if (title) seen.add(title);
    }
    return [...seen];
  });
  // Too few to fill two rows: the next page, while there is one.
  createEffect(() => {
    const page = popularPage();
    if (page && !page.loading && !page.done && popularTitles().length < POPULAR_WANTED) morePopular();
  });

  // Only when it starts or ends, not as each title is looked at.
  const matching = createMemo(() => titleMatcher.progress().running);

  /** The genres, most titles first, and the providers' categories, made again only when their titles change. */
  const sorted = (all: readonly T[]): Sorted<T> => {
    const every = vodLayout.categories() === "all";
    const categories = options.categories();
    const now = matching();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const last = sortedGroups.get(options.type) as Sorted<T> | undefined;
    if (
      last &&
      last.all === all &&
      last.every === every &&
      last.categories === categories &&
      last.matching === now
    )
      return last;

    const byGenre = new Map<string, T[]>();
    for (const title of all) {
      for (const genre of title.genres) {
        let list = byGenre.get(genre);
        if (!list) byGenre.set(genre, (list = []));
        list.push(title);
      }
    }
    let genreOrder = last?.genreOrder ?? [];
    // oxlint-disable-next-line unicorn/no-array-sort
    const ranked = [...byGenre].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    if (!now || genreOrder.length === 0) genreOrder = ranked.map(([genre]) => genre);
    else {
      genreOrder = genreOrder.slice();
      const known = new Set(genreOrder);
      for (const [genre] of ranked) if (!known.has(genre)) genreOrder.push(genre);
    }
    const genres: ExtraGroup<T>[] = [];
    for (const genre of genreOrder) {
      const items = byGenre.get(genre);
      if (items) genres.push({ id: `genre:${genre}`, label: genre, items, sortable: true });
    }

    // The sources' titles in their own categories: those Cinemeta doesn't have, or all.
    const byCategory = new Map<string, T[]>();
    for (const title of all) {
      if (title.imdb && !every) continue;
      for (const link of title.links) {
        if (!link.category) continue;
        let list = byCategory.get(link.category);
        if (!list) byCategory.set(link.category, (list = []));
        // Two copies in the same category: once. A title's are added together, so it'd be the last.
        if (list[list.length - 1] !== title) list.push(title);
      }
    }
    const categoryGroups: ExtraGroup<T>[] = [];
    for (const name of categories) {
      const items = byCategory.get(name);
      if (items) categoryGroups.push({ id: `category:${name}`, label: name, items, sortable: true });
    }
    const made = { all, every, categories, matching: now, genreOrder, genres, categoryGroups };
    sortedGroups.set(options.type, made);
    return made;
  };

  const groups = createMemo((): ExtraGroup<T>[] => {
    const { titles: all, byKey } = titles();
    const out: ExtraGroup<T>[] = [];
    const page = popularPage();
    if (popular())
      out.push({
        id: "popular",
        label: $t("vod.popular"),
        items: popularTitles(),
        loading: !page || page.loading,
      });
    const { genres, categoryGroups } = sorted(all);
    out.push(...genres);

    for (const group of fromAddons.extraGroups()) {
      const seen = new Set<T>();
      for (const item of group.items) {
        const title = byKey.get(options.keyOf(item.meta.id));
        if (title) seen.add(title);
      }
      out.push({ id: group.id, label: group.label, items: [...seen], loading: group.loading });
    }
    out.push(...categoryGroups);
    return out;
  });

  const onNearEnd = (groupId: string) => {
    if (groupId === "popular") morePopular();
    else fromAddons.onNearEnd(groupId);
  };

  /** The add-ons' search results, as titles. */
  const searchItems = createMemo(() => {
    const { byKey } = titles();
    const seen = new Set<T>();
    for (const item of fromAddons.searchItems()) {
      const title =
        byKey.get(options.keyOf(item.meta.id)) ?? options.merge([], () => undefined, [item]).titles[0];
      if (title) seen.add(title);
    }
    return [...seen];
  });

  return {
    titles,
    groups,
    onNearEnd,
    searchItems,
    searching: fromAddons.searching,
    onQuery: fromAddons.onQuery,
  };
};
