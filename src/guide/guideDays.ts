// The guide's programmes for the rows on screen, from the guide cache
// (src/data/guideCache.ts), read through the guide worker. A row asks for the
// days its span covers: those already read come back at once, and the rest
// are read, all in one message to the worker, with the rows updating when
// they arrive. The page also reads rows ahead of the scroll (`prefetch`), so
// moving down usually finds them ready.

import { createSignal } from "solid-js";
import { DAY, type StoredProgramme } from "../data/guideCodec";
import type { GuideCache } from "../data/guideCache";
import type { Channel } from "../data/lineup";
import { mergeDays } from "./timeline";

const keyOf = (source: string, guideId: string, day: number) => `${source}\n${guideId}\n${day}`;

/** The UTC days that `from` to `to` overlaps. */
export const daysBetween = (from: number, to: number) => {
  const days: number[] = [];
  for (let day = Math.floor(from / DAY); day * DAY < to; day++) days.push(day);
  return days;
};

export const createGuideDays = (guide: GuideCache) => {
  // Changes when a day arrives, for rows that were waiting for one.
  const [arrived, setArrived] = createSignal(0);
  const reading = new Set<string>();
  const failed = new Set<string>();
  let bumping = false;
  /** Totals for probes. */
  const stats = { requested: 0, arrived: 0, failed: 0 };

  const bump = () => {
    if (bumping) return;
    bumping = true;
    // One update for the days that arrive together.
    queueMicrotask(() => {
      bumping = false;
      setArrived(n => n + 1);
    });
  };

  const read = (source: string, guideId: string, day: number) => {
    const key = keyOf(source, guideId, day);
    if (reading.has(key) || failed.has(key)) return;
    reading.add(key);
    stats.requested++;
    guide
      .day(source, guideId, day)
      .catch((error: unknown) => {
        failed.add(key);
        console.error("Couldn't read the guide:", error);
      })
      .finally(() => {
        reading.delete(key);
        if (failed.has(key)) stats.failed++;
        else stats.arrived++;
        bump();
      });
  };

  return {
    /**
     * A channel's programmes from `from` to `to`, or undefined while some of
     * its days are still being read. Reactive: it reruns when they arrive.
     */
    programmes: (channel: Channel, from: number, to: number): readonly StoredProgramme[] | undefined => {
      const guideId = channel.guideId;
      if (!guideId) return [];
      const found: StoredProgramme[][] = [];
      let missing = false;
      for (const day of daysBetween(from, to)) {
        const programmes = guide.peek(channel.source, guideId, day);
        if (programmes) found.push(programmes);
        else if (failed.has(keyOf(channel.source, guideId, day))) found.push([]);
        else {
          missing = true;
          read(channel.source, guideId, day);
        }
      }
      if (missing) {
        arrived();
        return undefined;
      }
      return mergeDays(found);
    },
    /** Reads channels' days ahead of time, without waiting for them. */
    prefetch: (channels: readonly Channel[], from: number, to: number) => {
      const days = daysBetween(from, to);
      for (const channel of channels) {
        const guideId = channel.guideId;
        if (!guideId) continue;
        for (const day of days) {
          if (!guide.peek(channel.source, guideId, day)) read(channel.source, guideId, day);
        }
      }
    },
    /** Forgets failed reads, such as after an import replaced the guide. */
    reset: () => failed.clear(),
    stats,
  };
};

export type GuideDays = ReturnType<typeof createGuideDays>;
