// The modern Movies and Series pages' titles and groups (PLAN.md, "Movies
// and Series by title", step 4): every source's copy of a title and the
// add-ons' as one (src/data/titles.ts), then Popular, from Cinemeta, the
// genres, most titles first, the add-ons' catalogs, and last the provider
// categories: of the titles Cinemeta doesn't have, or of every title, as
// Settings has it (src/data/vodLayout.ts). A title is in the category of
// each of its copies. While titles are being matched, the genres keep the
// order they had, so the column doesn't shift as matches come in; new ones
// go last, and the order is made again once matching ends.

import { createEffect, createMemo } from "solid-js";
import type { AddonItem, Merger, Titles } from "../../data/titles";
import type { FilmEntry, SeriesEntry } from "../../data/vodLibrary";
import { addons, cinemeta, library, titleMatcher, vodLayout } from "../../library";
import type { TitleType } from "../../stremio/addons";
import { $t } from "../../translate";
import { useAddonGroups } from "./addonGroups";
import type { PickerLink } from "./StreamPicker";
import type { ExtraGroup } from "./VodHub";

/** Popular's pages asked for at most, while too few of its titles can be played. */
const POPULAR_PAGES = 8;
/** Popular asks for more until it has this many. */
const POPULAR_WANTED = 40;

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
  /** How far a title was watched, by its key. */
  progressOf?: (key: string) => number | undefined;
}

const KINDS: Record<string, string> = { m3u8: "HLS", mpd: "DASH", ts: "TS" };

/** What kind of file a link is, from its address, such as "MKV". */
export const fileKind = (url: string) => {
  const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  return ext ? (KINDS[ext] ?? ext.toUpperCase()) : "";
};

/** A title's IPTV copy as the picker's row: the source, the provider's name, the kind of file. */
export const linkRow = <L>(
  link: L,
  source: string,
  name: string,
  url: string,
  category?: string,
): PickerLink<L> => {
  const from = library.sources().find(one => one.id === source)?.name ?? source;
  return {
    link,
    text: `${from} · ${name}`,
    detail: [fileKind(url), category].filter(Boolean).join("   ·   "),
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

  const joined = options.createMerger();
  const titles = createMemo(() => {
    const items: AddonItem[] = [];
    for (const group of fromAddons.extraGroups()) items.push(...group.items);
    // Popular titles no source has join only if an add-on has streams for them.
    for (const meta of popularPage()?.items ?? [])
      if (addons.answers("stream", options.type, meta.id)) items.push({ meta, addon: "" });
    // Once: matchOf() isn't tracked, as it's asked for every title.
    titleMatcher.version();
    const merged = joined(options.entries(), titleMatcher.matchOf, items, titleMatcher.changes());
    const progressOf = options.progressOf;
    if (progressOf) {
      for (const title of merged.titles) {
        const part = progressOf(title.key);
        if (part !== undefined) title.progress = part;
      }
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
  /** The genres' order, kept while matching goes on. */
  let genreOrder: string[] = [];

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

    const byGenre = new Map<string, T[]>();
    for (const title of all) {
      for (const genre of title.genres) {
        let list = byGenre.get(genre);
        if (!list) byGenre.set(genre, (list = []));
        list.push(title);
      }
    }
    // oxlint-disable-next-line unicorn/no-array-sort
    const genres = [...byGenre].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    if (!matching() || genreOrder.length === 0) genreOrder = genres.map(([genre]) => genre);
    else {
      const known = new Set(genreOrder);
      for (const [genre] of genres) if (!known.has(genre)) genreOrder.push(genre);
    }
    for (const genre of genreOrder) {
      const items = byGenre.get(genre);
      if (items) out.push({ id: `genre:${genre}`, label: genre, items, sortable: true });
    }

    for (const group of fromAddons.extraGroups()) {
      const seen = new Set<T>();
      for (const item of group.items) {
        const title = byKey.get(options.keyOf(item.meta.id));
        if (title) seen.add(title);
      }
      out.push({ id: group.id, label: group.label, items: [...seen], loading: group.loading });
    }

    // The sources' titles in their own categories: those Cinemeta doesn't have, or all.
    const every = vodLayout.categories() === "all";
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
    for (const name of options.categories()) {
      const items = byCategory.get(name);
      if (items) out.push({ id: `category:${name}`, label: name, items, sortable: true });
    }
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
