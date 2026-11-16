// What the TV has from the account it's signed in to (src/data/sync.ts):
// its profiles, and the lists and Stremio add-ons each one uses. A pull
// builds it from Nuvio's sync_pull_profiles and public.addons, and the
// velio_iptv_lists table Velio's server adds; the TV only reads it.

export type ListKind = "m3u" | "xtream" | "stremio";

/** An IPTV list, or a Stremio add-on, from the account. */
export interface SyncedList {
  /** The list's id, or the add-on's; kept, so channel edits and favourites still match. */
  id: string;
  name: string;
  kind: ListKind;
  url?: string;
  server?: string;
  username?: string;
  password?: string;
  guideUrls?: string[];
  refreshHours: number;
  disabled?: boolean;
}

export interface DeviceProfile {
  /** Nuvio's profile_index, as text: "1" is the main profile. */
  id: string;
  name: string;
  /** "#rrggbb", drawn with profileInitial(name). */
  color: string;
  /** It has a PIN, which the server checks (verify_profile_pin). */
  locked?: true;
  /** The lists and add-ons this profile uses, in the account's order. */
  lists: string[];
}

/** What the TV shows: the account's profiles, and their lists and add-ons. */
export interface DeviceView {
  profiles: DeviceProfile[];
  lists: SyncedList[];
}

/**
 * Velio's colour for a profile that has none, as velio.tv draws it. Built,
 * not a literal: the build turns colour literals into the renderer's
 * numbers, and this one is kept with the view as text.
 */
export const DEFAULT_PROFILE_COLOR = "#".concat("1E88E5");
/** The letter drawn on every colour. */
export const PROFILE_LETTER_COLOR = "#ffffff";

export const isProfileColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

/** The first letter of a name, capitalised; "?" for none. */
export const profileInitial = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = trimmed.charCodeAt(0);
  const length = first >= 0xd800 && first <= 0xdbff && trimmed.length > 1 ? 2 : 1;
  return trimmed.slice(0, length).toUpperCase();
};

/** The longest name a TV registers under (Nuvio's device_name). */
export const MAX_DEVICE_NAME_LENGTH = 100;
