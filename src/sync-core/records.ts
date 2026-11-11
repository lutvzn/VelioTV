// Copied from VelioPlatform's packages/sync-core/src/records.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// What an account holds (PLAN.md, "Lists and the manifest"): lists, which
// are VelioTV's Source with a revision, or a Stremio add-on's address;
// profiles; and the manifest that says
// which profile has which list, at which revision, signed by the owner.
//
// Lists and profiles are only ever stored encrypted. The manifest is signed
// but not encrypted: it holds ids and numbers, which the server can count
// anyway.

import nacl from "tweetnacl";
import { toBase64 } from "./bytes";
import { array, count, id, optionalText, ReadProblem, record, text } from "./read";

/** Per account (PLAN.md, "Limits per account"). */
export const MAX_PROFILES = 8;
export const MAX_LISTS = 50;
export const MAX_DEVICES = 10;

export const MAX_NAME_LENGTH = 100;
export const MAX_URL_LENGTH = 2048;
export const MAX_GUIDE_URLS = 10;

/** VelioTV's choices (src/data/sources.ts). */
export const REFRESH_CHOICES = [6, 12, 24, 48, 168];
export const DEFAULT_REFRESH_HOURS = 24;

/** An M3U playlist, an Xtream login, or a Stremio add-on (its manifest's address in `url`). */
export type ListKind = "m3u" | "xtream" | "stremio";

export const isListKind = (value: unknown): value is ListKind =>
  value === "m3u" || value === "xtream" || value === "stremio";

/** Encrypted under its list key. VelioTV's Source, plus a format and revision. */
export interface SyncedList {
  format: 1;
  /** Kept, so VelioTV's channel edits and favourites still match. */
  id: string;
  /** Goes up by one on each change to this list. */
  rev: number;
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

/** A list's settings, as the form edits them. */
export type ListDraft = Omit<SyncedList, "format" | "id" | "rev">;

/** Encrypted under its profile key. */
export interface ProfileRecord {
  format: 1;
  id: string;
  rev: number;
  name: string;
  /** Its picture: an index into PROFILE_COLORS, drawn with the name's first letter. Older records have none. */
  color?: number;
  /** The profile PIN, four digits kept as typed, as VelioTV's parental PIN. */
  pin?: string;
}

/** A profile's settings, as the form edits them. */
export interface ProfileDraft {
  name: string;
  /** Left out when adding: the first colour no other profile has. Left out when changing: kept. */
  color?: number;
  /** Left out: kept (none when adding). null: removed. */
  pin?: string | null;
}

/** Signed by the owner's signing key; the server reads it, as it holds no secrets. */
export interface Manifest {
  format: 1;
  account: string;
  /** Goes up by one on any change in the account. */
  rev: number;
  /** Each profile's record revision, and the lists it can use. */
  profiles: { id: string; rev: number; lists: string[] }[];
  /** Every list, used by a profile or not, at its revision and key revision. */
  lists: { id: string; rev: number; keyRev: number }[];
  /**
   * TVs, the profiles each was given (Phase 3), and each TV's box public key
   * (Phase 6), so the owner can send it new keys later without trusting the
   * server for it. TVs signed in before Phase 6 have none.
   */
  devices: { id: string; profiles: string[]; publicKey?: string }[];
}

export const emptyManifest = (account: string): Manifest => ({
  format: 1,
  account,
  rev: 0,
  profiles: [],
  lists: [],
  devices: [],
});

/** A random id: 16 characters of URL-safe base64. Not replaceAll(), which Chromium 38 lacks. */
export const newId = () =>
  toBase64(nacl.randomBytes(12)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const noDuplicates = (ids: string[], what: string) => {
  if (new Set(ids).size !== ids.length) throw new ReadProblem(`${what} has an id twice`);
  return ids;
};

export const readManifest = (value: unknown): Manifest => {
  const manifest = record(value, "The manifest");
  if (manifest.format !== 1) throw new ReadProblem("The manifest has an unknown format");
  const read: Manifest = {
    format: 1,
    account: text(manifest.account, "The manifest's account", 64),
    rev: count(manifest.rev, "The manifest's rev"),
    profiles: array(manifest.profiles, "The manifest's profiles", MAX_PROFILES).map(item => {
      const profile = record(item, "A manifest profile");
      return {
        id: id(profile.id, "A manifest profile's id"),
        rev: count(profile.rev, "A manifest profile's rev"),
        lists: noDuplicates(
          array(profile.lists, "A manifest profile's lists", MAX_LISTS).map(list => id(list, "A list id")),
          "A manifest profile's lists",
        ),
      };
    }),
    lists: array(manifest.lists, "The manifest's lists", MAX_LISTS).map(item => {
      const list = record(item, "A manifest list");
      return {
        id: id(list.id, "A manifest list's id"),
        rev: count(list.rev, "A manifest list's rev"),
        keyRev: count(list.keyRev, "A manifest list's keyRev"),
      };
    }),
    devices: array(manifest.devices, "The manifest's devices", MAX_DEVICES).map(item => {
      const device = record(item, "A manifest device");
      const entry: Manifest["devices"][number] = {
        id: id(device.id, "A manifest device's id"),
        profiles: array(device.profiles, "A manifest device's profiles", MAX_PROFILES).map(profile =>
          id(profile, "A profile id"),
        ),
      };
      if (device.publicKey !== undefined) {
        const publicKey = text(device.publicKey, "A manifest device's public key", 44);
        if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey))
          throw new ReadProblem("A manifest device's public key isn't 32 bytes of base64");
        entry.publicKey = publicKey;
      }
      return entry;
    }),
  };
  noDuplicates(
    read.profiles.map(profile => profile.id),
    "The manifest's profiles",
  );
  noDuplicates(
    read.lists.map(list => list.id),
    "The manifest's lists",
  );
  noDuplicates(
    read.devices.map(device => device.id),
    "The manifest's devices",
  );
  const listIds = new Set(read.lists.map(list => list.id));
  for (const profile of read.profiles)
    for (const list of profile.lists)
      if (!listIds.has(list))
        throw new ReadProblem(`The manifest gives a profile list ${list}, which it doesn't have`);
  return read;
};

export const readList = (value: unknown): SyncedList => {
  const item = record(value, "A list");
  if (item.format !== 1) throw new ReadProblem("A list has an unknown format");
  if (!isListKind(item.kind)) throw new ReadProblem("A list has an unknown kind");
  const read: SyncedList = {
    format: 1,
    id: id(item.id, "A list's id"),
    rev: count(item.rev, "A list's rev"),
    name: text(item.name, "A list's name", MAX_NAME_LENGTH),
    kind: item.kind,
    refreshHours: count(item.refreshHours, "A list's refreshHours"),
  };
  for (const key of ["url", "server", "username", "password"] as const) {
    const field = optionalText(item[key], `A list's ${key}`, MAX_URL_LENGTH);
    if (field !== undefined) read[key] = field;
  }
  if (item.guideUrls !== undefined)
    read.guideUrls = array(item.guideUrls, "A list's guideUrls", MAX_GUIDE_URLS).map(url =>
      text(url, "A guide URL", MAX_URL_LENGTH),
    );
  if (item.disabled === true) read.disabled = true;
  return read;
};

export const readProfile = (value: unknown): ProfileRecord => {
  const item = record(value, "A profile");
  if (item.format !== 1) throw new ReadProblem("A profile has an unknown format");
  const read: ProfileRecord = {
    format: 1,
    id: id(item.id, "A profile's id"),
    rev: count(item.rev, "A profile's rev"),
    name: text(item.name, "A profile's name", MAX_NAME_LENGTH),
  };
  if (item.color !== undefined) {
    if (!isProfileColor(item.color)) throw new ReadProblem("A profile's color isn't one of the colors");
    read.color = item.color;
  }
  if (item.pin !== undefined) {
    if (!isProfilePin(item.pin)) throw new ReadProblem(`A profile's PIN isn't ${PROFILE_PIN_LENGTH} digits`);
    read.pin = item.pin;
  }
  return read;
};

// --- Profile pictures and PINs (Phase 4) ---

/**
 * The colours a profile's picture can have, one for each profile an account
 * can hold. Each keeps a white letter readable (contrast 4.9:1 or more) and
 * stands out 3:1 or more from both a white page and VelioTV's dark one.
 */
export const PROFILE_COLORS: readonly { name: string; background: string }[] = [
  { name: "Red", background: "#c8323c" },
  { name: "Orange", background: "#b8500f" },
  { name: "Gold", background: "#8f6a00" },
  { name: "Green", background: "#2e7d32" },
  { name: "Teal", background: "#00796b" },
  { name: "Blue", background: "#1f6fd1" },
  { name: "Purple", background: "#7b45b8" },
  { name: "Pink", background: "#b8317e" },
];
/** The letter drawn on every colour. */
export const PROFILE_LETTER_COLOR = "#ffffff";

export const PROFILE_PIN_LENGTH = 4;

export const isProfileColor = (value: unknown): value is number =>
  typeof value === "number" && value % 1 === 0 && value >= 0 && value < PROFILE_COLORS.length;

export const isProfilePin = (value: unknown): value is string =>
  typeof value === "string" && value.length === PROFILE_PIN_LENGTH && /^\d+$/.test(value);

/** A profile's colour; one made before pictures gets a steady one from its id. */
export const profileColor = (profile: Pick<ProfileRecord, "id" | "color">) => {
  if (profile.color !== undefined) return profile.color;
  let sum = 0;
  for (let i = 0; i < profile.id.length; i++) sum += profile.id.charCodeAt(i);
  return sum % PROFILE_COLORS.length;
};

/** The letter on a profile's picture: the name's first character, in capitals, whole even outside the BMP. */
export const profileInitial = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = trimmed.charCodeAt(0);
  const length = first >= 0xd800 && first <= 0xdbff && trimmed.length > 1 ? 2 : 1;
  return trimmed.slice(0, length).toUpperCase();
};

/** Whether `typed` opens the profile: true when it has no PIN. */
export const profilePinMatches = (profile: Pick<ProfileRecord, "pin">, typed: string) =>
  profile.pin === undefined || profile.pin === typed;

export type ProfileProblem = "name" | "tooLong" | "color" | "pin";

/** Why a profile draft can't be saved, or undefined. */
export const profileProblem = (draft: ProfileDraft): ProfileProblem | undefined => {
  if (!draft.name.trim()) return "name";
  if (draft.name.trim().length > MAX_NAME_LENGTH) return "tooLong";
  if (draft.color !== undefined && !isProfileColor(draft.color)) return "color";
  if (draft.pin !== undefined && draft.pin !== null && !isProfilePin(draft.pin)) return "pin";
  return undefined;
};

/** In English, for the web. */
export const PROFILE_PROBLEM_TEXT: Record<ProfileProblem, string> = {
  name: "Enter a name.",
  tooLong: "That name is too long.",
  color: "Choose one of the colours.",
  pin: `A profile PIN is ${PROFILE_PIN_LENGTH} digits. Leave it empty for none.`,
};

// --- The form's checks: the same as VelioTV's sourceProblem() ---

const isWebUrl = (value: string) => /^https?:\/\/[^\s/]+/i.test(value);

export type ListProblem =
  | "url"
  | "urlForm"
  | "addon"
  | "addonForm"
  | "server"
  | "login"
  | "guideForm"
  | "tooLong"
  | "refresh";

/**
 * A Stremio add-on's manifest address, as the owner may paste it: an install
 * link (stremio://…) means https://, and the add-on's own address has
 * /manifest.json added. Undefined unless it's a web address then.
 */
export const addonManifestUrl = (address: string) => {
  let url = address.trim().replace(/^stremio:\/\//i, "https://");
  if (!isWebUrl(url)) return undefined;
  if (!/\/manifest\.json$/i.test(url.split(/[?#]/)[0])) url = `${url.replace(/\/+$/, "")}/manifest.json`;
  return url;
};

/** Why a draft can't be saved, as VelioTV's source.problem keys, or undefined. */
export const listProblem = (draft: ListDraft): ListProblem | undefined => {
  if (draft.kind === "m3u") {
    if (!draft.url) return "url";
    if (!isWebUrl(draft.url)) return "urlForm";
  } else if (draft.kind === "stremio") {
    if (!draft.url) return "addon";
    if (!addonManifestUrl(draft.url)) return "addonForm";
  } else {
    if (!draft.server) return "server";
    if (!draft.username || !draft.password) return "login";
  }
  if (draft.guideUrls?.some(url => !isWebUrl(url))) return "guideForm";
  const fields = [
    draft.name,
    draft.url,
    draft.server,
    draft.username,
    draft.password,
    ...(draft.guideUrls ?? []),
  ];
  if (
    draft.name.length > MAX_NAME_LENGTH ||
    fields.some(field => field !== undefined && field.length > MAX_URL_LENGTH) ||
    (draft.guideUrls?.length ?? 0) > MAX_GUIDE_URLS
  )
    return "tooLong";
  if (!REFRESH_CHOICES.includes(draft.refreshHours)) return "refresh";
  return undefined;
};

/** In English, for the web. VelioTV has its own translations of the same keys. */
export const LIST_PROBLEM_TEXT: Record<ListProblem, string> = {
  url: "Enter the playlist's address.",
  urlForm: "The playlist's address must start with http:// or https://.",
  addon: "Enter the add-on's address.",
  addonForm: "The add-on's address must start with https://, http:// or stremio://.",
  server: "Enter the server's address.",
  login: "Enter the username and password.",
  guideForm: "Each guide address must start with http:// or https://.",
  tooLong: "Something in this list is too long.",
  refresh: "Choose how often to refresh.",
};

/** A name for a list the owner didn't name: its server's host name, as VelioTV does. */
export const defaultListName = (draft: ListDraft) => {
  const address = draft.kind === "xtream" ? draft.server : draft.url;
  if (!address) return "";
  try {
    return new URL(/^[a-z]+:\/\//i.test(address) ? address : `http://${address}`).hostname;
  } catch {
    return "";
  }
};

/** Splits a guide URL field, which can hold several URLs, on spaces. */
export const splitGuideUrls = (value: string) => value.split(/\s+/).filter(Boolean);
