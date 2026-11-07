// A channel's programmes for a day, read from the guide store once and kept
// in memory. Reading a channel's guide takes 60-100 ms on the TV (PLAN.md,
// Phase 2), so the Live TV page reads it only for the channel it shows, and
// coming back to a channel costs nothing.

import { DAY, type StoredProgramme } from "./guideCodec";

export interface GuideCacheOptions {
  /** A guide channel's programmes that overlap `from`..`to`, as readGuide() gives them. */
  read: (source: string, guideId: string, from: number, to: number) => Promise<StoredProgramme[]>;
  /** How many channel-days to keep. */
  size?: number;
}

export interface NowAndNext {
  now?: StoredProgramme;
  next?: StoredProgramme;
}

const keyOf = (source: string, guideId: string, day: number) => `${source}\n${guideId}\n${day}`;

/** The programme on at `at`, and the one after it. Programmes are in start order. */
export const nowAndNext = (programmes: readonly StoredProgramme[], at: number): NowAndNext => {
  const now = programmes.find(p => p.start <= at && p.stop > at);
  const after = now?.stop ?? at;
  return { now, next: programmes.find(p => p.start >= after) };
};

export const createGuideCache = (options: GuideCacheOptions) => {
  const size = options.size ?? 200;
  // In order of use, oldest first, so the first key is the one to drop.
  const days = new Map<string, Promise<StoredProgramme[]>>();
  const settled = new Map<string, StoredProgramme[]>();

  /** The programmes that overlap a UTC day, in start order. */
  const day = (source: string, guideId: string, dayNumber: number) => {
    const key = keyOf(source, guideId, dayNumber);
    let found = days.get(key);
    if (found) {
      days.delete(key);
    } else {
      found = options
        .read(source, guideId, dayNumber * DAY, (dayNumber + 1) * DAY)
        .then(programmes => {
          // toSorted() needs Chromium 110; older TVs are still targets.
          // oxlint-disable-next-line unicorn/no-array-sort
          const sorted = programmes.slice().sort((a, b) => a.start - b.start);
          if (days.get(key) === found) settled.set(key, sorted);
          return sorted;
        })
        .catch((error: unknown) => {
          // Not kept, so the next call reads it again.
          if (days.get(key) === found) days.delete(key);
          throw error;
        });
    }
    days.set(key, found);
    while (days.size > size) {
      const oldest = days.keys().next().value;
      if (oldest === undefined) break;
      days.delete(oldest);
      settled.delete(oldest);
    }
    return found;
  };

  return {
    day,
    /** A day already read, without waiting; undefined if it hasn't been. */
    peek: (source: string, guideId: string, dayNumber: number) =>
      settled.get(keyOf(source, guideId, dayNumber)),
    /** What is on at `at`, reading the next day too when nothing follows today. */
    nowAndNext: async (source: string, guideId: string, at: number): Promise<NowAndNext> => {
      const today = Math.floor(at / DAY);
      const found = nowAndNext(await day(source, guideId, today), at);
      if (found.next) return found;
      const tomorrow = nowAndNext(await day(source, guideId, today + 1), at);
      return { now: found.now ?? tomorrow.now, next: tomorrow.next };
    },
    /** Forgets everything, such as after an import replaced the guide. */
    clear: () => {
      days.clear();
      settled.clear();
    },
  };
};

export type GuideCache = ReturnType<typeof createGuideCache>;
