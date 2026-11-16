// The first page of each add-on catalog, kept in the database for 12 hours
// (PLAN.md, "Stremio add-ons"), so Movies and Series show their rows at once
// at the next start instead of after every add-on has answered.
//
// Each type's pages are one record, of at most 40 catalogs of 60 titles.
// Chromium keeps a value over 64 KB as a file of its own and gives its space
// back when it's replaced; a smaller one keeps its space until the database
// compacts, which the TV didn't do (src/data/db.ts). So a record under that
// size is padded past it, with text that doesn't compress.
//
// After NuvioTVSmart's catalog snapshot cache
// (https://github.com/NuvioMedia/NuvioTVSmart, GPL-3.0); changed: rewritten
// in TypeScript, kept in IndexedDB in two records over 64 KB.

import type { AddonMeta } from "./addon";

/** How long a kept first page is shown instead of asking the add-on. */
export const SNAPSHOT_MS = 12 * 3_600_000;
export const SNAPSHOT_ROWS = 40;
export const SNAPSHOT_ITEMS = 60;
/** A record's size at the least, in characters, to stay over 64 KB. */
export const SNAPSHOT_MIN_CHARS = 66_000;

export interface SnapshotPage {
  /** The catalog's key in src/stremio/addons.ts: "<list id>/<type>/<catalog id>". */
  key: string;
  /** The first page's address, so a changed add-on address isn't shown the old titles. */
  url: string;
  items: AddonMeta[];
  /** The catalog has no more pages. */
  done: boolean;
  at: number;
}

export interface SnapshotRecord {
  type: string;
  pages: SnapshotPage[];
  /** Filler that keeps the record over 64 KB. */
  pad?: string;
}

export interface CatalogSnapshots {
  read: (type: string) => Promise<SnapshotPage[]>;
  write: (record: SnapshotRecord) => Promise<void>;
}

export const isFresh = (page: SnapshotPage, now: number) => now - page.at < SNAPSHOT_MS && page.at <= now;

/** Text that doesn't compress, the same each time. */
export const filler = (length: number) => {
  let seed = 0x2545f491;
  let text = "";
  while (text.length < length) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) | 0;
    text += ((seed >>> 8) & 0xffffff).toString(36);
  }
  return text.slice(0, length);
};

/** The record for a type's pages: the fresh ones, `order`'s first, capped, padded past 64 KB. */
export const snapshotRecord = (
  type: string,
  pages: readonly SnapshotPage[],
  order: readonly string[],
  now: number,
): SnapshotRecord => {
  const rank = new Map(order.map((key, at) => [key, at]));
  const kept = pages
    .filter(page => isFresh(page, now))
    .map((page, at) => ({ page, at, rank: rank.get(page.key) ?? order.length }))
    // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .slice(0, SNAPSHOT_ROWS)
    .map(({ page }) => ({ ...page, items: page.items.slice(0, SNAPSHOT_ITEMS) }));
  const record: SnapshotRecord = { type, pages: kept };
  const size = JSON.stringify(record).length;
  if (size < SNAPSHOT_MIN_CHARS) record.pad = filler(SNAPSHOT_MIN_CHARS - size);
  return record;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPage = (value: unknown): value is SnapshotPage =>
  isObject(value) &&
  typeof value.key === "string" &&
  typeof value.url === "string" &&
  typeof value.at === "number" &&
  typeof value.done === "boolean" &&
  Array.isArray(value.items);

/** Pages read back from a record, leaving out any that don't read. */
export const recordPages = (value: unknown): SnapshotPage[] =>
  isObject(value) && Array.isArray(value.pages) ? value.pages.filter(isPage) : [];

/** Kept in the app's database (src/data/db.ts), opened when first wanted. */
export const createDbSnapshots = (db: {
  read: (type: string) => Promise<unknown>;
  write: (record: SnapshotRecord) => Promise<void>;
}): CatalogSnapshots => ({
  read: async type => recordPages(await db.read(type)),
  write: db.write,
});
