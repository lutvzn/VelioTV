// The add-ons' catalogs as groups for the Movies or Series page (PLAN.md,
// "Stremio add-ons", step 4): each named for its catalog and add-on, with
// its first page asked for when the page opens and the next as the cursor
// nears its end, and the add-ons' search results for the search typed.

import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { addons } from "../../library";
import type { AddonMeta } from "../../stremio/addon";
import type { TitleType } from "../../stremio/addons";
import type { ExtraGroup } from "./VodHub";

/** Waits this long after the last key before the add-ons are asked to search. */
const SEARCH_DELAY_MS = 300;

export const useAddonGroups = <T extends { key: string }>(
  type: TitleType,
  toEntry: (meta: AddonMeta, addon: string) => T,
) => {
  const groups = createMemo(() => addons.catalogs(type));

  // Every catalog's first page, once it's known.
  createEffect(() => {
    const loaded = addons.pages();
    for (const group of groups()) if (!loaded[group.key]) void addons.loadPage(group);
  });

  // Entries are made once per title and add-on, so the grid keeps its nodes.
  const made = new Map<string, T>();
  const entryOf = (meta: AddonMeta, addon: string) => {
    const key = `${addon}/${meta.id}`;
    let entry = made.get(key);
    if (!entry) made.set(key, (entry = toEntry(meta, addon)));
    return entry;
  };

  const extraGroups = createMemo((): ExtraGroup<T>[] => {
    const loaded = addons.pages();
    return groups().map(group => {
      const page = loaded[group.key];
      return {
        id: `addon:${group.key}`,
        label: `${group.catalog.name} · ${group.addonName}`,
        items: (page?.items ?? []).map(meta => entryOf(meta, group.addon)),
        loading: !page || page.loading,
      };
    });
  });

  const onNearEnd = (groupId: string) => {
    const group = groups().find(one => `addon:${one.key}` === groupId);
    if (group) void addons.loadPage(group);
  };

  const [searchItems, setSearchItems] = createSignal<T[]>([]);
  const [searching, setSearching] = createSignal(false);
  let asked = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onQuery = (query: string) => {
    clearTimeout(timer);
    const mine = ++asked;
    setSearchItems([]);
    if (!query) {
      setSearching(false);
      return;
    }
    setSearching(true);
    timer = setTimeout(() => {
      addons
        .search(type, query)
        .then(found => {
          if (mine === asked) setSearchItems(found.map(meta => entryOf(meta, meta.addon)));
          return undefined;
        })
        .catch(() => undefined)
        .finally(() => {
          if (mine === asked) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
  };
  onCleanup(() => clearTimeout(timer));

  return { extraGroups, onNearEnd, searchItems, searching, onQuery };
};
