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

/** Runs sorted by insertion before they're merged. */
const RUN = 16;

/**
 * 0 to keys.length - 1, in their keys' order, lowest first; those alike
 * keep their order. A merge sort of its own, over typed arrays and with the
 * keys compared in place: on Samsung TVs sort() is core-js's and slow
 * (src/data/sortedCopy.ts), and about half its time went in calling the
 * comparison.
 */
export const stableOrder = (keys: ArrayLike<number> | readonly string[]) => {
  const count = keys.length;
  let from = new Uint32Array(count);
  let to = new Uint32Array(count);
  for (let i = 0; i < count; i++) from[i] = i;
  for (let start = 0; start < count; start += RUN) {
    const end = Math.min(start + RUN, count);
    for (let i = start + 1; i < end; i++) {
      const one = from[i];
      const key = keys[one];
      let j = i - 1;
      while (j >= start && key < keys[from[j]]) {
        from[j + 1] = from[j];
        j--;
      }
      from[j + 1] = one;
    }
  }
  for (let width = RUN; width < count; width *= 2) {
    for (let start = 0; start < count; start += 2 * width) {
      const middle = Math.min(start + width, count);
      const end = Math.min(start + 2 * width, count);
      let left = start;
      let right = middle;
      let out = start;
      // Already in order: copied as it is.
      if (right >= end || !(keys[from[right]] < keys[from[right - 1]])) {
        while (left < end) to[out++] = from[left++];
        continue;
      }
      while (left < middle && right < end)
        to[out++] = keys[from[right]] < keys[from[left]] ? from[right++] : from[left++];
      while (left < middle) to[out++] = from[left++];
      while (right < end) to[out++] = from[right++];
    }
    const swap = from;
    from = to;
    to = swap;
  }
  return from;
};

/**
 * The titles in `sort`'s order, in a new list; as listed, the same list.
 * Titles alike keep their order. Sorted by keys made once.
 */
export const sortTitles = <T extends Ordered>(items: readonly T[], sort: TitleSort): readonly T[] => {
  if (sort === "listed" || items.length < 2) return items;
  let order: Uint32Array;
  if (sort === "name") order = stableOrder(items.map(item => foldedNames(item)[0]));
  else {
    const keys = new Float64Array(items.length);
    for (let i = 0; i < items.length; i++) keys[i] = descending(items[i][sort]);
    order = stableOrder(keys);
  }
  const out: T[] = [];
  for (let i = 0; i < order.length; i++) out.push(items[order[i]]);
  return out;
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
