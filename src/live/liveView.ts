// What Live TV shows, once the user's edits (src/data/channelEdits.ts) are
// applied to the lineup (PLAN.md, Phase 5, steps 2, 3 and 5):
//
// - hidden channels, and every channel in a hidden group, are left out of
//   everything: All channels, the groups, Favourites, zapping, search and
//   number entry. Settings lists them, to show them again;
// - a channel moved to another group shows in that group instead of its own;
// - groups take the user's names and order, then any not ordered yet, in the
//   order their first channel appears; custom groups show once they have
//   channels;
// - each group keeps the playlist's order, or is sorted by number or name;
// - Favourites, while there are any, comes first, in the user's order;
// - a channel is locked when it, or the group it shows in, is.
//
// For 10,000 channels this is a few passes over the list, run again only
// when the lineup or the edits change.

import type { ChannelEdits, GroupSort } from "../data/channelEdits";
import type { Channel, ChannelGroup } from "../data/lineup";
import { FAVOURITES } from "./groups";

export interface LiveView {
  /** Every channel shown, in lineup order. */
  channels: Channel[];
  /** Favourites, then the groups, as shown. */
  groups: ChannelGroup[];
  /** The key of the group a channel shows in. */
  groupOf: (channel: Channel) => string;
  isShown: (channel: Channel) => boolean;
  isLocked: (channel: Channel) => boolean;
}

const byName = (a: Channel, b: Channel) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.index - b.index;
const byNumber = (a: Channel, b: Channel) =>
  (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || byName(a, b);

export const sortChannels = (channels: Channel[], sort: GroupSort) => {
  if (sort === "playlist") return channels;
  // A copy, as the lineup's own order stays; toSorted() is newer than some TVs.
  // oxlint-disable-next-line unicorn/no-array-sort
  return channels.slice().sort(sort === "name" ? byName : byNumber);
};

export const buildLiveView = (
  lineup: readonly Channel[],
  find: (id: string) => Channel | undefined,
  edits: ChannelEdits,
): LiveView => {
  const hiddenChannels = new Set(edits.hiddenChannels);
  const hiddenGroups = new Set(edits.hiddenGroups);
  const lockedChannels = new Set(edits.lockedChannels);
  const lockedGroups = new Set(edits.lockedGroups);
  const moved = edits.movedChannels;
  const groupOf = (channel: Channel) => moved[channel.id] ?? channel.group ?? "";
  const isShown = (channel: Channel) =>
    !hiddenChannels.has(channel.id) && !hiddenGroups.has(groupOf(channel));

  const channels: Channel[] = [];
  const byGroup = new Map<string, Channel[]>();
  for (const channel of lineup) {
    if (!isShown(channel)) continue;
    channels.push(channel);
    const key = groupOf(channel);
    let list = byGroup.get(key);
    if (!list) byGroup.set(key, (list = []));
    list.push(channel);
  }

  // The user's order first, then the rest as they first appear.
  const ordered = edits.groupOrder.filter(key => byGroup.has(key));
  const placed = new Set(ordered);
  for (const key of byGroup.keys()) if (!placed.has(key)) ordered.push(key);
  const groups: ChannelGroup[] = ordered.map(key => ({
    name: key,
    channels: sortChannels(byGroup.get(key) ?? [], edits.groupSort[key] ?? "playlist"),
  }));

  const favourites: Channel[] = [];
  for (const id of edits.favourites) {
    const channel = find(id);
    if (channel && isShown(channel)) favourites.push(channel);
  }
  if (favourites.length > 0) groups.unshift({ name: FAVOURITES, channels: favourites });

  return {
    channels,
    groups,
    groupOf,
    isShown,
    isLocked: channel => lockedChannels.has(channel.id) || lockedGroups.has(groupOf(channel)),
  };
};
