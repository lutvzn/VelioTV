// Channel search in the TV guide (PLAN.md, Phase 4, step 4): channels whose
// name holds every word typed, ignoring case and accents, so "cafe tv"
// finds "Café TV ᴴᴰ". Programme titles aren't searched: that would mean
// unpacking every stored guide day, about two minutes on the TV for a large
// source.

import type { Channel } from "../data/lineup";

/** Text folded for matching: lower case, without accents. */
export const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** The channels that match `query`, in lineup order; none for an empty query. */
export const searchChannels = (channels: readonly Channel[], query: string) => {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return channels.filter(channel => {
    const name = fold(channel.name);
    return words.every(word => name.includes(word));
  });
};
