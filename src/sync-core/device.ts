// Copied from VelioPlatform's packages/sync-core/src/device.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// A TV's pull (PLAN.md, "VelioTV pulling"). The server sends each TV only
// what its profiles may read: the signed manifest, the TV's boxed profile
// keys, those profiles' records, and their lists with the list keys wrapped
// under those profiles' keys.
//
//   pullFor()    the server's side: picks that out of what the account holds
//   openPull()   the TV's side: checks everything against the signed
//                manifest and opens it, reusing lists that didn't change

import { fromBase64 } from "./bytes";
import { openBoxedKey, openJson, unwrapKey, verifyJson, type Sealed, type Signed } from "./crypto";
import { array, count, id, ReadProblem, record, text } from "./read";
import {
  MAX_DEVICES,
  MAX_LISTS,
  MAX_PROFILES,
  readList,
  readManifest,
  profileColor,
  readProfile,
  type SyncedList,
} from "./records";
import type { StoredState } from "./changes";

export interface KeyFor {
  profile: string;
  key: Sealed;
}

/** What GET /v1/sync answers a TV. */
export interface SyncPull {
  format: 1;
  manifest: Signed;
  /** The TV's own id in the manifest. */
  device: string;
  /** This TV's profile keys, boxed from the owner's box key. */
  keys: KeyFor[];
  profiles: { id: string; rev: number; sealed: Sealed }[];
  /** Each list a profile of this TV has, with its key wrapped under those profiles' keys only. */
  lists: { id: string; rev: number; keyRev: number; sealed: Sealed; keys: KeyFor[] }[];
}

/** The server's side: what one TV may read, or null when the manifest doesn't name it. */
export const pullFor = (stored: StoredState, deviceId: string): SyncPull | null => {
  const device = stored.devices.find(item => item.id === deviceId);
  if (!stored.manifest || !device) return null;
  const mine = new Set(device.keys.map(key => key.profile));
  return {
    format: 1,
    manifest: stored.manifest,
    device: deviceId,
    keys: device.keys,
    profiles: stored.profiles
      .filter(profile => mine.has(profile.id))
      .map(profile => ({ id: profile.id, rev: profile.rev, sealed: profile.sealed })),
    lists: stored.lists
      .filter(list => list.profileKeys.some(key => mine.has(key.profile)))
      .map(list => ({
        id: list.id,
        rev: list.rev,
        keyRev: list.keyRev,
        sealed: list.sealed,
        keys: list.profileKeys.filter(key => mine.has(key.profile)),
      })),
  };
};

// --- The TV's side ---

/** What the TV keeps from signing in (the pairing payload, and its own secret key). */
export interface DeviceTrust {
  account: string;
  device: string;
  /** The TV's box secret key, base64. */
  secretKey: string;
  signPublicKey: string;
  boxPublicKey: string;
}

export interface DeviceProfile {
  id: string;
  name: string;
  /** An index into PROFILE_COLORS, drawn with profileInitial(name). */
  color: number;
  /** Asked for before the profile opens (profilePinMatches()), when set. */
  pin?: string;
  /** The lists this profile can use, in the account's order. */
  lists: string[];
}

/** What the TV shows: its profiles and their lists, at one manifest revision. */
export interface DeviceView {
  rev: number;
  profiles: DeviceProfile[];
  lists: SyncedList[];
}

/** The account no longer names this TV: it was removed, or the account was reset. Sign out. */
export class DeviceRemoved extends Error {
  constructor() {
    super("This TV is no longer signed in to the account");
    this.name = "DeviceRemoved";
  }
}

const readSealedLoosely = (value: unknown, what: string): Sealed => {
  const item = record(value, what);
  return { nonce: text(item.nonce, `${what}'s nonce`, 32), box: text(item.box, `${what}'s box`, 64_000) };
};

const readKeys = (value: unknown, what: string): KeyFor[] =>
  array(value, what, MAX_PROFILES).map(entry => {
    const key = record(entry, what);
    return { profile: id(key.profile, "A profile id"), key: readSealedLoosely(key.key, what) };
  });

export const readSyncPull = (value: unknown): SyncPull => {
  const item = record(value, "The pull");
  if (item.format !== 1) throw new ReadProblem("The pull has an unknown format");
  const manifest = record(item.manifest, "The manifest");
  return {
    format: 1,
    manifest: {
      body: text(manifest.body, "The manifest", 64_000),
      signature: text(manifest.signature, "The signature", 88),
    },
    device: id(item.device, "The TV's id"),
    keys: readKeys(item.keys, "A profile key"),
    profiles: array(item.profiles, "The profiles", MAX_PROFILES).map(entry => {
      const profile = record(entry, "A profile");
      return {
        id: id(profile.id, "A profile's id"),
        rev: count(profile.rev, "A profile's rev"),
        sealed: readSealedLoosely(profile.sealed, "A profile"),
      };
    }),
    lists: array(item.lists, "The lists", MAX_LISTS).map(entry => {
      const list = record(entry, "A list");
      return {
        id: id(list.id, "A list's id"),
        rev: count(list.rev, "A list's rev"),
        keyRev: count(list.keyRev, "A list's keyRev"),
        sealed: readSealedLoosely(list.sealed, "A list"),
        keys: readKeys(list.keys, "A list key"),
      };
    }),
  };
};

/**
 * Checks a pull and opens it. The manifest must be signed by the owner, for
 * this account, no older than the last one applied, and name this TV; the
 * profile keys must come from the owner's box key; each record must be the
 * revision the manifest names. Lists at the same revision as in `previous`
 * are kept from it rather than opened again.
 *
 * Throws DeviceRemoved when the account no longer names this TV, and any
 * other error when something doesn't check out (keep the last view then).
 */
export const openPull = (trust: DeviceTrust, input: unknown, previous?: DeviceView): DeviceView => {
  const pull = readSyncPull(input);
  const manifest = readManifest(verifyJson(fromBase64(trust.signPublicKey), pull.manifest));
  if (manifest.account !== trust.account) throw new ReadProblem("The pull is for another account");
  if (previous && manifest.rev < previous.rev) throw new ReadProblem("The pull is older than the last one");
  if (manifest.devices.length > MAX_DEVICES) throw new ReadProblem("The manifest names too many TVs");
  const me = manifest.devices.find(device => device.id === trust.device);
  if (!me) throw new DeviceRemoved();

  const ownerBox = fromBase64(trust.boxPublicKey);
  const secretKey = fromBase64(trust.secretKey);
  const profileKeys = new Map<string, Uint8Array>();
  for (const entry of pull.keys)
    if (me.profiles.indexOf(entry.profile) >= 0)
      profileKeys.set(entry.profile, openBoxedKey(ownerBox, secretKey, entry.key));

  const profiles = me.profiles.map((profileId): DeviceProfile => {
    const key = profileKeys.get(profileId);
    const entry = manifest.profiles.find(profile => profile.id === profileId);
    const stored = pull.profiles.find(profile => profile.id === profileId);
    if (!key || !entry || !stored) throw new ReadProblem(`Profile ${profileId} is missing from the pull`);
    const opened = readProfile(openJson(key, stored.sealed));
    if (opened.id !== profileId || opened.rev !== entry.rev || stored.rev !== entry.rev)
      throw new ReadProblem(`Profile ${profileId} isn't the revision the manifest names`);
    const profile: DeviceProfile = {
      id: profileId,
      name: opened.name,
      color: profileColor(opened),
      lists: entry.lists.slice(),
    };
    if (opened.pin !== undefined) profile.pin = opened.pin;
    return profile;
  });

  const wanted = new Set<string>();
  for (const profile of profiles) for (const listId of profile.lists) wanted.add(listId);
  const kept = new Map<string, SyncedList>();
  if (previous) for (const list of previous.lists) kept.set(list.id, list);

  const lists: SyncedList[] = [];
  for (const entry of manifest.lists) {
    if (!wanted.has(entry.id)) continue;
    const stored = pull.lists.find(list => list.id === entry.id);
    if (!stored || stored.rev !== entry.rev || stored.keyRev !== entry.keyRev)
      throw new ReadProblem(`List ${entry.id} isn't the revision the manifest names`);
    const old = kept.get(entry.id);
    if (old && old.rev === entry.rev) {
      lists.push(old);
      continue;
    }
    const wrapped = stored.keys.find(key => profileKeys.has(key.profile));
    const profileKey = wrapped && profileKeys.get(wrapped.profile);
    if (!wrapped || !profileKey) throw new ReadProblem(`List ${entry.id} has no key for this TV`);
    const opened = readList(openJson(unwrapKey(profileKey, wrapped.key), stored.sealed));
    if (opened.id !== entry.id || opened.rev !== entry.rev)
      throw new ReadProblem(`List ${entry.id} isn't the revision the manifest names`);
    lists.push(opened);
  }
  return { rev: manifest.rev, profiles, lists };
};
