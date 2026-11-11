// How the Movies and Series pages order a group's titles, and their search
// results (src/pages/vod/VodHub.tsx): a group can be sorted by when its
// titles were added, by name, year or rating, or kept as listed; search
// results come best first, the same name before names that start with it,
// then names with words that start so, then any that hold the words.

import type { TitleSort } from "../../data/vodSorts";
import { fold } from "../../guide/search";

export interface Ordered {
  key: string;
  name: string;
  added?: number;
  year?: number;
  rating?: number;
}

/** A name for comparing and searching: folded, with punctuation as spaces. */
const searchable = (name: string) =>
  ` ${fold(name)
    .replace(/[\s!-/:-@[-`{-~]+/g, " ")
    .trim()} `;

type NamesOf<T> = (item: T) => readonly string[];
/** Each title's names folded, for each way of naming them, as a search would fold them again otherwise. */
const foldedBy = new WeakMap<object, WeakMap<object, string[]>>();
const ownNames = new WeakMap<object, string[]>();
const foldedNames = <T extends Ordered>(item: T, namesOf?: NamesOf<T>) => {
  let folded = ownNames;
  if (namesOf) {
    const kept = foldedBy.get(namesOf);
    if (kept) folded = kept;
    else foldedBy.set(namesOf, (folded = new WeakMap()));
  }
  let names = folded.get(item);
  if (!names) {
    names = [searchable(item.name)];
    for (const other of namesOf?.(item) ?? []) {
      const one = searchable(other);
      if (!names.includes(one)) names.push(one);
    }
    folded.set(item, names);
  }
  return names;
};

/** Newest or highest first; titles without one go last. */
const descending = (value: number | undefined) => (value === undefined ? Infinity : -value);

/**
 * The titles in `sort`'s order, in a new list; as listed, the same list.
 * Titles alike keep their order. Sorted by keys made once, as on Samsung
 * TVs sort() is core-js's and slow (src/data/sortedCopy.ts).
 */
export const sortTitles = <T extends Ordered>(items: readonly T[], sort: TitleSort): readonly T[] => {
  if (sort === "listed" || items.length < 2) return items;
  const order = items.map((_, i) => i);
  if (sort === "name") {
    const names = items.map(item => foldedNames(item)[0]);
    // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
    order.sort((a, b) => (names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : a - b));
  } else {
    const keys = items.map(item => descending(item[sort]));
    // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
    order.sort((a, b) => keys[a] - keys[b] || a - b);
  }
  return order.map(i => items[i]);
};

/**
 * How well a folded name answers the folded query and its words: 0 the
 * same, 1 starting with it, 2 each word starting a word of it, 3 holding
 * each word, or undefined.
 */
const rank = (name: string, query: string, words: readonly string[]) => {
  if (name === ` ${query} `) return 0;
  if (name.startsWith(` ${query}`)) return 1;
  if (!words.every(word => name.includes(word))) return undefined;
  return words.every(word => name.includes(` ${word}`)) ? 2 : 3;
};

/**
 * The titles whose name, or one of `namesOf`'s (such as each source's name
 * for it), holds every word typed, ignoring case and accents, best first.
 */
export const searchTitles = <T extends Ordered>(
  items: readonly T[],
  typed: string,
  namesOf?: NamesOf<T>,
): T[] => {
  const query = searchable(typed).trim();
  const words = query.split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const byRank: T[][] = [[], [], [], []];
  for (const item of items) {
    let best: number | undefined;
    for (const name of foldedNames(item, namesOf)) {
      const found = rank(name, query, words);
      if (found !== undefined && (best === undefined || found < best)) best = found;
      if (best === 0) break;
    }
    if (best !== undefined) byRank[best].push(item);
  }
  return byRank[0].concat(byRank[1], byRank[2], byRank[3]);
};
