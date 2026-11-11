// Copied from VelioPlatform's packages/sync-core/src/changes.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// Changing an account (PLAN.md, "Changing who can use what"). Everything is
// built on the owner's device: new records, their keys, and a new manifest
// signed by the owner. The server only checks that a change is signed,
// starts from the account's current revision, stays within the limits, and
// leaves records that match the new manifest exactly. It can't read any of
// it.
//
//   openState()      what the owner's device does with what the server holds
//   withList() …     the owner's edits, on an opened state
//   buildChange()    the difference between two opened states, sealed and signed
//   applyChange()    what the server does with a change

import { fromBase64, fromUtf8, toBase64 } from "./bytes";
import {
  boxKey,
  newKey,
  openJson,
  sealJson,
  signJson,
  unwrapKey,
  verifyJson,
  wrapKey,
  type Sealed,
  type Signed,
} from "./crypto";
import type { OwnerKeys } from "./owner";
import { array, count, id, ReadProblem, record, text } from "./read";
import {
  addonManifestUrl,
  defaultListName,
  emptyManifest,
  MAX_DEVICES,
  MAX_GUIDE_URLS,
  MAX_LISTS,
  MAX_PROFILES,
  newId,
  PROFILE_COLORS,
  PROFILE_PROBLEM_TEXT,
  profileColor,
  profileProblem,
  readList,
  readManifest,
  readProfile,
  type ListDraft,
  type Manifest,
  type ProfileDraft,
  type ProfileRecord,
  type SyncedList,
} from "./records";

// --- What the server holds: ciphertext, ids and numbers ---

export interface StoredProfile {
  id: string;
  rev: number;
  /** The ProfileRecord, sealed under the profile key. */
  sealed: Sealed;
  /** The profile key, wrapped under the account key. */
  key: Sealed;
}

export interface StoredList {
  id: string;
  rev: number;
  keyRev: number;
  /** The SyncedList, sealed under the list key. */
  sealed: Sealed;
  /** The list key, wrapped under the account key. */
  key: Sealed;
  /** The list key, wrapped under the key of each profile that can use it. */
  profileKeys: { profile: string; key: Sealed }[];
}

/** A TV signed in to the account: its profile keys, boxed from the owner's box key to the TV's key. */
export interface StoredDevice {
  id: string;
  keys: { profile: string; key: Sealed }[];
}

export interface StoredState {
  manifest: Signed | null;
  profiles: StoredProfile[];
  lists: StoredList[];
  devices: StoredDevice[];
}

/** One change, as POST /changes takes it. */
export interface Change {
  format: 1;
  /** The manifest revision the change was built on; the server answers 409 if the account has moved on. */
  baseRev: number;
  manifest: Signed;
  putProfiles: StoredProfile[];
  deleteProfiles: string[];
  putLists: StoredList[];
  deleteLists: string[];
  /** TVs signed in by this change (and, from Phase 6, TVs given new keys). */
  putDevices: StoredDevice[];
  deleteDevices: string[];
}

export type ChangeProblemCode = "behind" | "refused" | "limit";

export class ChangeProblem extends Error {
  constructor(
    readonly code: ChangeProblemCode,
    message: string,
  ) {
    super(message);
    this.name = "ChangeProblem";
  }
}

const refused = (message: string) => new ChangeProblem("refused", message);

// --- Reading changes and stored state ---

/** Base64 of 24 bytes. */
const NONCE_LENGTH = 32;
/** A wrapped 32-byte key: 4-byte length + key + 16-byte tag, in base64. */
const WRAPPED_KEY_LENGTH = 72;
/** A profile record pads to 1 KB; a list to at most about 31 KB (10 long guide URLs). */
const MAX_PROFILE_BOX = 4096;
const MAX_LIST_BOX = 48_000;

const readSealed = (value: unknown, what: string, maxBox: number): Sealed => {
  const item = record(value, what);
  const nonce = text(item.nonce, `${what}'s nonce`, NONCE_LENGTH);
  const box = text(item.box, `${what}'s box`, maxBox);
  if (nonce.length !== NONCE_LENGTH) throw new ReadProblem(`${what}'s nonce is the wrong size`);
  return { nonce, box };
};

const readWrappedKey = (value: unknown, what: string) => {
  const sealed = readSealed(value, what, WRAPPED_KEY_LENGTH);
  if (sealed.box.length !== WRAPPED_KEY_LENGTH) throw new ReadProblem(`${what} is the wrong size`);
  return sealed;
};

const readSigned = (value: unknown, what: string): Signed => {
  const item = record(value, what);
  return {
    body: text(item.body, `${what}'s body`, 64_000),
    signature: text(item.signature, `${what}'s signature`, 88),
  };
};

const readStoredProfile = (value: unknown): StoredProfile => {
  const item = record(value, "A profile");
  return {
    id: id(item.id, "A profile's id"),
    rev: count(item.rev, "A profile's rev"),
    sealed: readSealed(item.sealed, "A profile", MAX_PROFILE_BOX),
    key: readWrappedKey(item.key, "A profile's key"),
  };
};

const readStoredList = (value: unknown): StoredList => {
  const item = record(value, "A list");
  return {
    id: id(item.id, "A list's id"),
    rev: count(item.rev, "A list's rev"),
    keyRev: count(item.keyRev, "A list's keyRev"),
    sealed: readSealed(item.sealed, "A list", MAX_LIST_BOX),
    key: readWrappedKey(item.key, "A list's key"),
    profileKeys: array(item.profileKeys, "A list's profile keys", MAX_PROFILES).map(entry => {
      const key = record(entry, "A list's profile key");
      return {
        profile: id(key.profile, "A profile id"),
        key: readWrappedKey(key.key, "A list's profile key"),
      };
    }),
  };
};

const readStoredDevice = (value: unknown): StoredDevice => {
  const item = record(value, "A TV");
  return {
    id: id(item.id, "A TV's id"),
    keys: array(item.keys, "A TV's keys", MAX_PROFILES).map(entry => {
      const key = record(entry, "A TV's profile key");
      return { profile: id(key.profile, "A profile id"), key: readWrappedKey(key.key, "A TV's profile key") };
    }),
  };
};

/** Pages from before Phase 3 send no TVs. */
const optionalArray = (value: unknown, what: string, maxLength: number) =>
  value === undefined ? [] : array(value, what, maxLength);

export const readChange = (value: unknown): Change => {
  const item = record(value, "The change");
  if (item.format !== 1) throw new ReadProblem("The change has an unknown format");
  return {
    format: 1,
    baseRev: count(item.baseRev, "The change's baseRev"),
    manifest: readSigned(item.manifest, "The change's manifest"),
    putProfiles: array(item.putProfiles, "The changed profiles", MAX_PROFILES).map(readStoredProfile),
    deleteProfiles: array(item.deleteProfiles, "The deleted profiles", MAX_PROFILES).map(profile =>
      id(profile, "A deleted profile"),
    ),
    putLists: array(item.putLists, "The changed lists", MAX_LISTS).map(readStoredList),
    deleteLists: array(item.deleteLists, "The deleted lists", MAX_LISTS).map(list =>
      id(list, "A deleted list"),
    ),
    putDevices: optionalArray(item.putDevices, "The changed TVs", MAX_DEVICES).map(readStoredDevice),
    deleteDevices: optionalArray(item.deleteDevices, "The removed TVs", MAX_DEVICES).map(device =>
      id(device, "A removed TV"),
    ),
  };
};

/** Reads a stored state as JSON, such as the copy on a web page. */
export const readStoredState = (value: unknown): StoredState => {
  const item = record(value, "The account");
  return {
    manifest: item.manifest === null ? null : readSigned(item.manifest, "The manifest"),
    profiles: array(item.profiles, "The profiles", MAX_PROFILES).map(readStoredProfile),
    lists: array(item.lists, "The lists", MAX_LISTS).map(readStoredList),
    devices: optionalArray(item.devices, "The TVs", MAX_DEVICES).map(readStoredDevice),
  };
};

/** The manifest's body without checking its signature: for the server, reading what it stored itself. */
export const storedManifest = (stored: StoredState, account: string): Manifest =>
  stored.manifest
    ? readManifest(JSON.parse(fromUtf8(fromBase64(stored.manifest.body))))
    : emptyManifest(account);

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const set = new Set(a);
  return set.size === a.length && a.length === b.length && b.every(item => set.has(item));
};

/** Checks that stored records are exactly the ones a manifest names, at its revisions. */
export const checkMatches = (stored: Omit<StoredState, "manifest">, manifest: Manifest) => {
  const profiles = new Map(stored.profiles.map(profile => [profile.id, profile]));
  if (profiles.size !== stored.profiles.length) throw refused("A profile is stored twice");
  if (
    !sameSet(
      [...profiles.keys()],
      manifest.profiles.map(profile => profile.id),
    )
  )
    throw refused("The profiles don't match the manifest");
  for (const entry of manifest.profiles)
    if (profiles.get(entry.id)?.rev !== entry.rev)
      throw refused(`Profile ${entry.id} isn't at the manifest's revision`);

  const lists = new Map(stored.lists.map(list => [list.id, list]));
  if (lists.size !== stored.lists.length) throw refused("A list is stored twice");
  if (
    !sameSet(
      [...lists.keys()],
      manifest.lists.map(list => list.id),
    )
  )
    throw refused("The lists don't match the manifest");
  for (const entry of manifest.lists) {
    const list = lists.get(entry.id);
    if (list?.rev !== entry.rev || list.keyRev !== entry.keyRev)
      throw refused(`List ${entry.id} isn't at the manifest's revision`);
    const holders = manifest.profiles
      .filter(profile => profile.lists.includes(entry.id))
      .map(profile => profile.id);
    if (
      !sameSet(
        list.profileKeys.map(key => key.profile),
        holders,
      )
    )
      throw refused(`List ${entry.id}'s keys aren't for the profiles the manifest gives it to`);
  }

  const devices = new Map(stored.devices.map(device => [device.id, device]));
  if (devices.size !== stored.devices.length) throw refused("A TV is stored twice");
  if (
    !sameSet(
      [...devices.keys()],
      manifest.devices.map(device => device.id),
    )
  )
    throw refused("The TVs don't match the manifest");
  for (const entry of manifest.devices) {
    if (entry.profiles.some(profileId => !profiles.has(profileId)))
      throw refused(`TV ${entry.id} is given a profile the account doesn't have`);
    if (!sameSet(devices.get(entry.id)?.keys.map(key => key.profile) ?? [], entry.profiles))
      throw refused(`TV ${entry.id}'s keys aren't for the profiles the manifest gives it`);
  }
};

/** The lists a set of profiles can use, in a manifest. */
const reachable = (manifest: Manifest, profileIds: readonly string[]) => {
  const lists = new Set<string>();
  for (const profile of manifest.profiles)
    if (profileIds.includes(profile.id)) for (const listId of profile.lists) lists.add(listId);
  return lists;
};

/**
 * A TV that loses a profile, or is removed, kept the keys it had. So the
 * server checks the owner's device made new ones (PLAN.md, "Changing who
 * can use what"): each profile a TV lost is sealed again, the TVs keeping it
 * are sent its new key, and each list the TV could use and now can't has a
 * new key. The server can't see the keys themselves, only that the records
 * were replaced, which catches a client that forgot.
 */
const checkRekeyed = (before: Manifest, after: Manifest, change: Change) => {
  const putProfiles = new Set(change.putProfiles.map(profile => profile.id));
  const putDevices = new Set(change.putDevices.map(device => device.id));
  const profilesAfter = new Set(after.profiles.map(profile => profile.id));
  const listsBefore = new Map(before.lists.map(list => [list.id, list]));
  const listsAfter = new Map(after.lists.map(list => [list.id, list]));
  for (const device of before.devices) {
    const kept = after.devices.find(item => item.id === device.id)?.profiles ?? [];
    for (const profileId of device.profiles) {
      if (kept.includes(profileId) || !profilesAfter.has(profileId)) continue;
      if (!putProfiles.has(profileId))
        throw refused(`Profile ${profileId} needs a new key, as TV ${device.id} lost it`);
      for (const other of after.devices)
        if (other.profiles.includes(profileId) && !putDevices.has(other.id))
          throw refused(`TV ${other.id} needs profile ${profileId}'s new key`);
    }
    const canNow = reachable(after, kept);
    for (const listId of reachable(before, device.profiles)) {
      const old = listsBefore.get(listId);
      const now = listsAfter.get(listId);
      if (old && now && !canNow.has(listId) && now.keyRev <= old.keyRev)
        throw refused(`List ${listId} needs a new key, as TV ${device.id} can't use it any more`);
    }
  }
};

/** What applyChange() may take beyond the owner's signature. */
export interface ChangeOptions {
  /** TVs this change may add: the one being signed in, as the server knows from its pairing. */
  newDevices?: readonly string[];
}

// --- The server's side ---

/**
 * Checks a change against what the server holds, and returns what it will
 * hold after. Throws a ChangeProblem: "behind" (409) when the change was
 * built on an older revision, "limit" past the limits per account, and
 * "refused" for anything else.
 */
export const applyChange = (
  stored: StoredState,
  input: unknown,
  account: string,
  signPublicKey: Uint8Array,
  options: ChangeOptions = {},
): { state: StoredState; change: Change; manifest: Manifest } => {
  let change: Change;
  try {
    change = readChange(input);
  } catch (error) {
    throw refused(error instanceof Error ? error.message : "The change isn't readable");
  }
  const currentRev = storedManifest(stored, account).rev;
  if (change.baseRev !== currentRev)
    throw new ChangeProblem(
      "behind",
      `The change was made on revision ${change.baseRev}; the account is at ${currentRev}`,
    );

  let manifest: Manifest;
  try {
    manifest = readManifest(verifyJson(signPublicKey, change.manifest));
  } catch (error) {
    throw refused(`The manifest isn't signed by the owner, or isn't readable: ${String(error)}`);
  }
  if (manifest.account !== account) throw refused("The manifest is for another account");
  if (manifest.rev !== currentRev + 1) throw refused("The manifest's revision must go up by one");
  if (manifest.devices.length > MAX_DEVICES) throw new ChangeProblem("limit", `At most ${MAX_DEVICES} TVs`);
  if (manifest.profiles.length > MAX_PROFILES)
    throw new ChangeProblem("limit", `At most ${MAX_PROFILES} profiles`);
  if (manifest.lists.length > MAX_LISTS) throw new ChangeProblem("limit", `At most ${MAX_LISTS} lists`);

  const touched = [
    ...change.putProfiles.map(profile => `p:${profile.id}`),
    ...change.deleteProfiles.map(profileId => `p:${profileId}`),
    ...change.putLists.map(list => `l:${list.id}`),
    ...change.deleteLists.map(listId => `l:${listId}`),
    ...change.putDevices.map(device => `d:${device.id}`),
    ...change.deleteDevices.map(deviceId => `d:${deviceId}`),
  ];
  if (new Set(touched).size !== touched.length) throw refused("The change names a record twice");

  const profiles = new Map(stored.profiles.map(profile => [profile.id, profile]));
  for (const profileId of change.deleteProfiles)
    if (!profiles.delete(profileId)) throw refused(`Profile ${profileId} doesn't exist`);
  for (const profile of change.putProfiles) {
    const old = profiles.get(profile.id);
    if (old && profile.rev <= old.rev) throw refused(`Profile ${profile.id}'s revision must go up`);
    profiles.set(profile.id, profile);
  }

  const lists = new Map(stored.lists.map(list => [list.id, list]));
  for (const listId of change.deleteLists)
    if (!lists.delete(listId)) throw refused(`List ${listId} doesn't exist`);
  for (const list of change.putLists) {
    const old = lists.get(list.id);
    if (old && (list.rev <= old.rev || list.keyRev < old.keyRev))
      throw refused(`List ${list.id}'s revision must go up`);
    lists.set(list.id, list);
  }
  const devices = new Map(stored.devices.map(device => [device.id, device]));
  for (const deviceId of change.deleteDevices)
    if (!devices.delete(deviceId)) throw refused(`TV ${deviceId} doesn't exist`);
  for (const device of change.putDevices) {
    if (!devices.has(device.id) && !(options.newDevices ?? []).some(allowed => allowed === device.id))
      throw refused(`TV ${device.id} can only be added by signing it in`);
    devices.set(device.id, device);
  }
  checkRekeyed(storedManifest(stored, account), manifest, change);
  // A deleted profile's copies of list keys go with it; a TV keeps only the keys of the profiles it has.
  const given = new Map(manifest.devices.map(device => [device.id, new Set(device.profiles)]));
  const next: StoredState = {
    manifest: change.manifest,
    profiles: [...profiles.values()],
    lists: [...lists.values()].map(list => ({
      ...list,
      profileKeys: list.profileKeys.filter(key => profiles.has(key.profile)),
    })),
    devices: [...devices.values()].map(device => ({
      ...device,
      keys: device.keys.filter(key => profiles.has(key.profile) && given.get(device.id)?.has(key.profile)),
    })),
  };
  checkMatches(next, manifest);
  return { state: next, change, manifest };
};

// --- The owner's side ---

export interface OpenedProfile {
  record: ProfileRecord;
  key: Uint8Array;
}

export interface OpenedList {
  record: SyncedList;
  key: Uint8Array;
  keyRev: number;
  /** The profiles that can use it. */
  profiles: string[];
}

export interface OpenedDevice {
  id: string;
  /** The profiles the TV was given. */
  profiles: string[];
  /** Its box public key, to box its profile keys to: from the signed manifest, or from signing it in. */
  publicKey?: Uint8Array;
}

export interface OpenedState {
  manifest: Manifest;
  profiles: OpenedProfile[];
  lists: OpenedList[];
  devices: OpenedDevice[];
}

const sameKey = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
};

/**
 * What the owner's device does with what the server sent: checks the
 * manifest's signature, that the records are the ones it names, opens every
 * key and record, and checks each record says it's the revision the manifest
 * names. So the server can't hide a change, serve an old version, or swap
 * a key for one of its own.
 */
export const openState = (owner: OwnerKeys, account: string, stored: StoredState): OpenedState => {
  const manifest = stored.manifest
    ? readManifest(verifyJson(owner.signing.publicKey, stored.manifest))
    : emptyManifest(account);
  if (manifest.account !== account) throw refused("The manifest is for another account");
  checkMatches(stored, manifest);

  const profiles = stored.profiles.map((item): OpenedProfile => {
    const key = unwrapKey(owner.accountKey, item.key);
    const opened = readProfile(openJson(key, item.sealed));
    if (opened.id !== item.id || opened.rev !== item.rev)
      throw refused(`Profile ${item.id} isn't the revision it's stored as`);
    return { record: opened, key };
  });
  const profileKeys = new Map(profiles.map(profile => [profile.record.id, profile.key]));

  const lists = stored.lists.map((item): OpenedList => {
    const key = unwrapKey(owner.accountKey, item.key);
    const opened = readList(openJson(key, item.sealed));
    if (opened.id !== item.id || opened.rev !== item.rev)
      throw refused(`List ${item.id} isn't the revision it's stored as`);
    for (const entry of item.profileKeys) {
      const profileKey = profileKeys.get(entry.profile);
      if (!profileKey || !sameKey(unwrapKey(profileKey, entry.key), key))
        throw refused(`List ${item.id}'s key for profile ${entry.profile} isn't its key`);
    }
    return {
      record: opened,
      key,
      keyRev: item.keyRev,
      profiles: item.profileKeys.map(entry => entry.profile),
    };
  });

  // In the manifest's order, which is the order they were made in.
  const profileOrder = manifest.profiles.map(entry => entry.id);
  const listOrder = manifest.lists.map(entry => entry.id);
  profiles.sort((a, b) => profileOrder.indexOf(a.record.id) - profileOrder.indexOf(b.record.id));
  lists.sort((a, b) => listOrder.indexOf(a.record.id) - listOrder.indexOf(b.record.id));
  // checkMatches() has made sure the TVs' keys are for exactly these profiles.
  const devices = manifest.devices.map((entry): OpenedDevice => {
    const device: OpenedDevice = { id: entry.id, profiles: [...entry.profiles] };
    if (entry.publicKey !== undefined) device.publicKey = fromBase64(entry.publicKey);
    return device;
  });
  return { manifest, profiles, lists, devices };
};

/** Leaves out empty optional fields, so a list's JSON is the same however the form was filled. */
const cleanDraft = (draft: ListDraft): ListDraft => {
  const clean: ListDraft = {
    name: draft.name.trim() || defaultListName(draft),
    kind: draft.kind,
    refreshHours: draft.refreshHours,
  };
  const fields = draft.kind === "xtream" ? (["server", "username", "password"] as const) : (["url"] as const);
  for (const field of fields) {
    const value = draft[field]?.trim();
    if (value) clean[field] = value;
  }
  // An add-on is kept by its manifest's address, which is what TVs ask for.
  if (draft.kind === "stremio" && clean.url) clean.url = addonManifestUrl(clean.url) ?? clean.url;
  // An add-on has no guide, and nothing to refresh on a timer.
  if (draft.kind === "stremio") {
    if (draft.disabled) clean.disabled = true;
    return clean;
  }
  const guideUrls = (draft.guideUrls ?? []).map(url => url.trim()).filter(Boolean);
  if (guideUrls.length > 0) clean.guideUrls = guideUrls.slice(0, MAX_GUIDE_URLS);
  if (draft.disabled) clean.disabled = true;
  return clean;
};

/**
 * Adds a list, or changes one. Taking it from a profile gives it a new key,
 * so a TV that kept the old one can't open the new version.
 */
export const withList = (
  state: OpenedState,
  draft: ListDraft,
  profileIds: readonly string[],
  listId?: string,
): { state: OpenedState; listId: string } => {
  const known = new Set(state.profiles.map(profile => profile.record.id));
  const profiles = [...new Set(profileIds)].filter(profileId => known.has(profileId));
  const content = cleanDraft(draft);
  if (listId === undefined) {
    if (state.lists.length >= MAX_LISTS)
      throw new ChangeProblem("limit", `An account can have at most ${MAX_LISTS} lists.`);
    const list: OpenedList = {
      record: { format: 1, id: newId(), rev: 1, ...content },
      key: newKey(),
      keyRev: 1,
      profiles,
    };
    return { state: { ...state, lists: [...state.lists, list] }, listId: list.record.id };
  }
  const existing = state.lists.find(list => list.record.id === listId);
  if (!existing) throw refused(`List ${listId} doesn't exist`);
  const taken = existing.profiles.some(profileId => !profiles.includes(profileId));
  const changed: OpenedList = {
    record: { format: 1, id: listId, rev: existing.record.rev + 1, ...content },
    key: taken ? newKey() : existing.key,
    keyRev: taken ? existing.keyRev + 1 : existing.keyRev,
    profiles,
  };
  return {
    state: { ...state, lists: state.lists.map(list => (list === existing ? changed : list)) },
    listId,
  };
};

export const withoutList = (state: OpenedState, listId: string): OpenedState => {
  if (!state.lists.some(list => list.record.id === listId)) throw refused(`List ${listId} doesn't exist`);
  return { ...state, lists: state.lists.filter(list => list.record.id !== listId) };
};

/**
 * Adds a profile, or changes one's name, colour or PIN. A new profile with
 * no colour gets the first one no other profile has.
 */
export const withProfile = (
  state: OpenedState,
  draft: ProfileDraft,
  profileId?: string,
): { state: OpenedState; profileId: string } => {
  const problem = profileProblem(draft);
  if (problem) throw new ChangeProblem("refused", PROFILE_PROBLEM_TEXT[problem]);
  const name = draft.name.trim();
  const withPin = (before: ProfileRecord): ProfileRecord => {
    if (draft.pin === undefined) return before;
    const { pin: _old, ...rest } = before;
    return draft.pin === null ? rest : { ...rest, pin: draft.pin };
  };
  if (profileId === undefined) {
    if (state.profiles.length >= MAX_PROFILES)
      throw new ChangeProblem("limit", `An account can have at most ${MAX_PROFILES} profiles.`);
    const taken = state.profiles.map(profile => profileColor(profile.record));
    const free = PROFILE_COLORS.findIndex((_color, index) => !taken.includes(index));
    const profile: OpenedProfile = {
      record: withPin({ format: 1, id: newId(), rev: 1, name, color: draft.color ?? Math.max(free, 0) }),
      key: newKey(),
    };
    return { state: { ...state, profiles: [...state.profiles, profile] }, profileId: profile.record.id };
  }
  const existing = state.profiles.find(profile => profile.record.id === profileId);
  if (!existing) throw refused(`Profile ${profileId} doesn't exist`);
  const changed: OpenedProfile = {
    ...existing,
    record: withPin({
      ...existing.record,
      rev: existing.record.rev + 1,
      name,
      color: draft.color ?? profileColor(existing.record),
    }),
  };
  return {
    state: { ...state, profiles: state.profiles.map(profile => (profile === existing ? changed : profile)) },
    profileId,
  };
};

/** Deletes a profile. Each of its lists gets a new key, as when a list is taken from a profile. */
export const withoutProfile = (state: OpenedState, profileId: string): OpenedState => {
  if (!state.profiles.some(profile => profile.record.id === profileId))
    throw refused(`Profile ${profileId} doesn't exist`);
  return {
    ...state,
    profiles: state.profiles.filter(profile => profile.record.id !== profileId),
    lists: state.lists.map(list =>
      list.profiles.includes(profileId)
        ? {
            record: { ...list.record, rev: list.record.rev + 1 },
            key: newKey(),
            keyRev: list.keyRev + 1,
            profiles: list.profiles.filter(other => other !== profileId),
          }
        : list,
    ),
    devices: state.devices.map(device => ({
      ...device,
      profiles: device.profiles.filter(other => other !== profileId),
    })),
  };
};

/**
 * Signs in a TV: gives it the chosen profiles. buildChange() boxes their
 * keys to the TV's public key, which came sealed under the pairing secret.
 */
export const withDevice = (
  state: OpenedState,
  deviceId: string,
  publicKey: Uint8Array,
  profileIds: readonly string[],
): OpenedState => {
  if (state.devices.some(device => device.id === deviceId))
    throw refused(`TV ${deviceId} is already signed in`);
  if (state.devices.length >= MAX_DEVICES)
    throw new ChangeProblem("limit", `An account can have at most ${MAX_DEVICES} TVs.`);
  const known = new Set(state.profiles.map(profile => profile.record.id));
  const profiles = [...new Set(profileIds)].filter(profileId => known.has(profileId));
  if (profiles.length === 0) throw new ChangeProblem("refused", "Choose at least one profile for this TV.");
  return { ...state, devices: [...state.devices, { id: deviceId, profiles, publicKey }] };
};

/**
 * New keys for profiles a TV lost (PLAN.md, "Changing who can use what"):
 * each gets a new key and revision, and so does every list it has. The TVs
 * that keep the profile get its new key (buildChange() boxes it to them);
 * the TV that lost it kept the old keys, which open no new version.
 */
const rekeyProfiles = (state: OpenedState, profileIds: readonly string[]): OpenedState => {
  const rekeyed = new Set(profileIds);
  return {
    ...state,
    profiles: state.profiles.map(profile =>
      rekeyed.has(profile.record.id)
        ? { record: { ...profile.record, rev: profile.record.rev + 1 }, key: newKey() }
        : profile,
    ),
    lists: state.lists.map(list =>
      list.profiles.some(profileId => rekeyed.has(profileId))
        ? {
            ...list,
            record: { ...list.record, rev: list.record.rev + 1 },
            key: newKey(),
            keyRev: list.keyRev + 1,
          }
        : list,
    ),
  };
};

/** Changes which profiles a TV has. Profiles taken from it get new keys, as do their lists. */
export const withDeviceProfiles = (
  state: OpenedState,
  deviceId: string,
  profileIds: readonly string[],
): OpenedState => {
  const device = state.devices.find(item => item.id === deviceId);
  if (!device) throw refused(`TV ${deviceId} isn't signed in`);
  const known = new Set(state.profiles.map(profile => profile.record.id));
  const profiles = [...new Set(profileIds)].filter(profileId => known.has(profileId));
  if (profiles.length === 0)
    throw new ChangeProblem("refused", "Choose at least one profile for this TV, or remove it.");
  const taken = device.profiles.filter(profileId => !profiles.includes(profileId));
  const changed: OpenedState = {
    ...state,
    devices: state.devices.map(item => (item === device ? { ...item, profiles } : item)),
  };
  return taken.length > 0 ? rekeyProfiles(changed, taken) : changed;
};

/** Removes a TV. Each of its profiles gets a new key, as do their lists, so it can't open a new version. */
export const withoutDevice = (state: OpenedState, deviceId: string): OpenedState => {
  const device = state.devices.find(item => item.id === deviceId);
  if (!device) throw refused(`TV ${deviceId} isn't signed in`);
  return rekeyProfiles({ ...state, devices: state.devices.filter(item => item !== device) }, device.profiles);
};

const sealProfile = (owner: OwnerKeys, profile: OpenedProfile): StoredProfile => ({
  id: profile.record.id,
  rev: profile.record.rev,
  sealed: sealJson(profile.key, profile.record),
  key: wrapKey(owner.accountKey, profile.key),
});

const sealList = (owner: OwnerKeys, list: OpenedList, profileKeys: Map<string, Uint8Array>): StoredList => ({
  id: list.record.id,
  rev: list.record.rev,
  keyRev: list.keyRev,
  sealed: sealJson(list.key, list.record),
  key: wrapKey(owner.accountKey, list.key),
  profileKeys: list.profiles.map(profile => {
    const profileKey = profileKeys.get(profile);
    if (!profileKey) throw refused(`Profile ${profile} doesn't exist`);
    return { profile, key: wrapKey(profileKey, list.key) };
  }),
});

const membershipChanged = (before: OpenedList, after: OpenedList) =>
  !sameSet(before.profiles, after.profiles);

/**
 * The change from one opened state to another: the records that are new or
 * changed, sealed again, what was deleted, and the new manifest, signed.
 * A list whose profiles changed without a new revision gets one, as the
 * server only takes records whose revision goes up.
 */
export const buildChange = (owner: OwnerKeys, before: OpenedState, after: OpenedState): Change => {
  const beforeProfiles = new Map(before.profiles.map(profile => [profile.record.id, profile]));
  const beforeLists = new Map(before.lists.map(list => [list.record.id, list]));
  const lists = after.lists.map(list => {
    const old = beforeLists.get(list.record.id);
    return old && old.record.rev === list.record.rev && membershipChanged(old, list)
      ? { ...list, record: { ...list.record, rev: list.record.rev + 1 } }
      : list;
  });
  const profileKeys = new Map(after.profiles.map(profile => [profile.record.id, profile.key]));
  const afterProfileIds = new Set(after.profiles.map(profile => profile.record.id));
  const afterListIds = new Set(lists.map(list => list.record.id));

  const manifest: Manifest = {
    format: 1,
    account: before.manifest.account,
    rev: before.manifest.rev + 1,
    profiles: after.profiles.map(profile => ({
      id: profile.record.id,
      rev: profile.record.rev,
      lists: lists.filter(list => list.profiles.includes(profile.record.id)).map(list => list.record.id),
    })),
    lists: lists.map(list => ({ id: list.record.id, rev: list.record.rev, keyRev: list.keyRev })),
    devices: after.devices.map(device => {
      const entry: Manifest["devices"][number] = { id: device.id, profiles: device.profiles };
      if (device.publicKey) entry.publicKey = toBase64(device.publicKey);
      return entry;
    }),
  };
  const beforeDevices = new Map(before.devices.map(device => [device.id, device]));
  /**
   * A TV needs its keys boxed again when it's new, gains a profile, or keeps
   * one that has a new key. Losing a profile needs nothing: the server drops
   * the keys the manifest no longer gives it.
   */
  const needsKeys = (device: OpenedDevice) => {
    const old = beforeDevices.get(device.id);
    if (!old || device.profiles.some(profileId => !old.profiles.includes(profileId))) return true;
    return device.profiles.some(profileId => {
      const was = beforeProfiles.get(profileId)?.key;
      const now = profileKeys.get(profileId);
      return !was || !now || !sameKey(was, now);
    });
  };
  const afterDevices = new Set(after.devices.map(device => device.id));

  return {
    format: 1,
    baseRev: before.manifest.rev,
    manifest: signJson(owner.signing.secretKey, manifest),
    putProfiles: after.profiles
      .filter(profile => beforeProfiles.get(profile.record.id)?.record.rev !== profile.record.rev)
      .map(profile => sealProfile(owner, profile)),
    deleteProfiles: before.profiles
      .map(profile => profile.record.id)
      .filter(profileId => !afterProfileIds.has(profileId)),
    putLists: lists
      .filter(list => beforeLists.get(list.record.id)?.record.rev !== list.record.rev)
      .map(list => sealList(owner, list, profileKeys)),
    deleteLists: before.lists.map(list => list.record.id).filter(listId => !afterListIds.has(listId)),
    putDevices: after.devices.filter(needsKeys).map(device => {
      const publicKey = device.publicKey;
      if (!publicKey)
        throw new ChangeProblem(
          "refused",
          "A TV signed in before new keys could be sent to it needs signing in again: remove it, then sign it in.",
        );
      return {
        id: device.id,
        keys: device.profiles.map(profile => {
          const profileKey = profileKeys.get(profile);
          if (!profileKey) throw refused(`Profile ${profile} doesn't exist`);
          return { profile, key: boxKey(publicKey, owner.box.secretKey, profileKey) };
        }),
      };
    }),
    deleteDevices: before.devices.map(device => device.id).filter(deviceId => !afterDevices.has(deviceId)),
  };
};
