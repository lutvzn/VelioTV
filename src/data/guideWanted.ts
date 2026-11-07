// Which guide channels an import keeps, and from when (PLAN.md, Phase 8,
// step 2):
//
// - only channels some source's playlist uses, matched by tvg-id ignoring
//   case; a source without a playlist keeps the whole guide;
// - not those of channels the user hid, or that are in a hidden group, as
//   Live TV leaves them out (src/live/liveView.ts). Showing one again
//   imports its source again (src/library.ts);
// - a channel's past only as far back as its catch-up reaches, and for a
//   channel without catch-up, from the start of the day (local time), as
//   nothing earlier can be played.
//
// A guide shared by several sources (db.ts) keeps what any of them wants.

import { catchupDays } from "./catchup";
import { DAY, type GuideMeta } from "./db";
import type { PlaylistChannel } from "./types";

/** The user's edits that hide channels (src/data/channelEdits.ts). */
export interface GuideFilter {
  hiddenChannels: string[];
  hiddenGroups: string[];
  movedChannels: Record<string, string>;
}

/** The most days of guide kept before today, for catch-up. */
export const MAX_PAST_DAYS = 7;

/** A playlist channel with its app id ("<source>/<key>", channelList.ts). */
export type IdentifiedChannel = Pick<PlaylistChannel, "guideId" | "group" | "catchup"> & { id: string };

/** Whether Live TV shows a channel, as buildLiveView() decides it. */
export const shownBy = (filter: GuideFilter | undefined) => {
  if (!filter) return () => true;
  const hiddenChannels = new Set(filter.hiddenChannels);
  const hiddenGroups = new Set(filter.hiddenGroups);
  const moved = filter.movedChannels;
  return (channel: Pick<IdentifiedChannel, "id" | "group">) =>
    !hiddenChannels.has(channel.id) && !hiddenGroups.has(moved[channel.id] ?? channel.group ?? "");
};

/** The guide channels wanted, lower-cased, each with the time its programmes are kept from. */
export class Wanted {
  ids = new Map<string, number>();
  /** Set when every channel is wanted, from then. */
  all: number | undefined;

  /** Wants a guide channel from `from`, or from earlier if it is already wanted so. */
  add(id: string, from: number) {
    const key = id.toLowerCase();
    const known = this.ids.get(key);
    if (known === undefined || from < known) this.ids.set(key, from);
  }

  addAll(from: number) {
    this.all = Math.min(this.all ?? from, from);
  }

  /** Wants what `other` wants too. */
  merge(other: Wanted) {
    for (const [id, from] of other.ids) this.add(id, from);
    if (other.all !== undefined) this.addAll(other.all);
  }

  /** When a guide channel's programmes are kept from, or undefined if it isn't wanted. */
  from(id: string): number | undefined {
    const known = this.ids.get(id.toLowerCase());
    if (this.all === undefined) return known;
    return known === undefined ? this.all : Math.min(known, this.all);
  }

  /** The earliest time any channel is kept from. */
  earliest(): number | undefined {
    let first = this.all;
    for (const from of this.ids.values()) first = Math.min(first ?? from, from);
    return first;
  }

  toMeta(): GuideMeta["wanted"] {
    const wanted: GuideMeta["wanted"] = { ids: [...this.ids.keys()], from: [...this.ids.values()] };
    if (this.all !== undefined) wanted.all = this.all;
    return wanted;
  }

  /** Whether a guide imported for `stored` holds everything this wants. */
  coveredBy(stored: GuideMeta["wanted"]) {
    if (this.all !== undefined && !(stored.all !== undefined && stored.all <= this.all)) return false;
    const storedFrom = new Map<string, number>();
    stored.ids.forEach((id, i) => storedFrom.set(id, stored.from[i]));
    for (const [id, from] of this.ids) {
      const kept = storedFrom.get(id) ?? stored.all;
      if (kept === undefined || kept > from) return false;
    }
    return true;
  }
}

export interface WantOptions {
  now: number;
  /** Keep every channel from this many days before today (UTC), instead of by its catch-up. */
  pastDays?: number;
  filter?: GuideFilter;
}

/** The start of the local day `now` is in. */
export const localDayStart = (now: number) => {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** Adds a playlist's shown channels to `wanted`. */
export const wantChannels = (
  wanted: Wanted,
  channels: readonly IdentifiedChannel[],
  options: WantOptions,
) => {
  const shown = shownBy(options.filter);
  const today = Math.floor(options.now / DAY);
  const dayStart = localDayStart(options.now);
  for (const channel of channels) {
    if (!channel.guideId || !shown(channel)) continue;
    let from: number;
    if (options.pastDays !== undefined) from = (today - options.pastDays) * DAY;
    else {
      const back = Math.min(MAX_PAST_DAYS, catchupDays(channel));
      from = back > 0 ? Math.min(dayStart, options.now - back * DAY) : dayStart;
    }
    wanted.add(channel.guideId, from);
  }
};

/** Wants the whole guide, for a source without a playlist. */
export const wantAll = (wanted: Wanted, options: WantOptions) =>
  wanted.addAll((Math.floor(options.now / DAY) - (options.pastDays ?? 1)) * DAY);
