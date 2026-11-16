// The add-on stream last played for each film and episode (PLAN.md,
// "Auto-play"), so with "Play the last link again" on, it plays again
// without the picker for a day. A few dozen small entries in one record of
// the profile's storage.
//
// After NuvioTVSmart's streamLinkReuse.js and streamLinkCacheStore.js
// (https://github.com/NuvioMedia/NuvioTVSmart, GPL-3.0); changed: rewritten
// in TypeScript, keeping only what an add-on's web stream needs.

import type { AddonStream } from "../stremio/addon";

export const LAST_LINKS_KEY = "velio.lastLinks";
/** How long a link is played again for. */
export const LAST_LINK_MS = 24 * 3_600_000;
const MAX_LINKS = 60;

export interface LastLink {
  /** The watched item's key (src/data/watched.ts). */
  key: string;
  addon: string;
  addonName: string;
  stream: AddonStream;
  at: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const read = (storage: Pick<Storage, "getItem">): LastLink[] => {
  try {
    const value: unknown = JSON.parse(storage.getItem(LAST_LINKS_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (one): one is LastLink =>
        isObject(one) &&
        typeof one.key === "string" &&
        typeof one.addon === "string" &&
        typeof one.addonName === "string" &&
        typeof one.at === "number" &&
        isObject(one.stream) &&
        typeof one.stream.url === "string",
    );
  } catch {
    return [];
  }
};

export const createLastLinks = (options: {
  storage: Pick<Storage, "getItem" | "setItem">;
  now?: () => number;
}) => {
  const now = options.now ?? (() => Date.now());
  return {
    /** The link played for `key` in the last day, if any. */
    find: (key: string) => {
      const found = read(options.storage).find(one => one.key === key);
      return found && now() - found.at < LAST_LINK_MS ? found : undefined;
    },
    keep: (link: Omit<LastLink, "at">) => {
      const others = read(options.storage).filter(
        one => one.key !== link.key && now() - one.at < LAST_LINK_MS,
      );
      try {
        options.storage.setItem(
          LAST_LINKS_KEY,
          JSON.stringify([{ ...link, at: now() }, ...others].slice(0, MAX_LINKS)),
        );
      } catch (error) {
        console.warn("Couldn't keep the last link:", error);
      }
    },
    forget: (key: string) => {
      const others = read(options.storage).filter(one => one.key !== key);
      try {
        options.storage.setItem(LAST_LINKS_KEY, JSON.stringify(others));
      } catch {
        // Nothing to forget.
      }
    },
  };
};

export type LastLinks = ReturnType<typeof createLastLinks>;
