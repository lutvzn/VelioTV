// Group keys and the names shown for them. Favourites (PLAN.md, Phase 5,
// step 2) is a group like the others, under a key no playlist group has, so
// zapping in it stays in it and the guide and the channel list need nothing
// of their own for it. Custom groups' keys start with CUSTOM_GROUP
// (src/data/channelEdits.ts).

import { $t } from "../translate";

/** The Favourites group's key. Playlist group names are text, never this. */
export const FAVOURITES = "\u0000favourites";

/**
 * A group's name as shown: undefined is every channel, then Favourites, a
 * name the user gave, or the playlist's.
 */
export const groupLabel = (key: string | undefined, names: Readonly<Record<string, string>> = {}) => {
  if (key === undefined) return $t("live.allChannels");
  if (key === FAVOURITES) return $t("live.favourites");
  return names[key] ?? (key || $t("live.noGroup"));
};
