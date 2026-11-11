// Copied from VelioPlatform's packages/sync-core/src/testAccount.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// A made-up account as one TV would pull it, for Phase 0's TV checks
// (PLAN.md, Phase 0): a signed manifest, the TV's boxed profile keys, the
// profiles' names, and lists sealed under their own keys, each wrapped for
// the profiles that can use it. Its lists point at example.invalid, which
// can't resolve, never at real sources.
//
// `openForDevice()` is what a TV does with it, and what the probe times.

import { fromBase64, toBase64 } from "./bytes";
import {
  boxKey,
  isRecord,
  newBoxKeyPair,
  newKey,
  newSigningKeyPair,
  openBoxedKey,
  openJson,
  sealJson,
  signJson,
  unwrapKey,
  verifyJson,
  wrapKey,
  type Sealed,
  type Signed,
} from "./crypto";

export interface TestList {
  format: 1;
  id: string;
  rev: number;
  name: string;
  kind: "m3u" | "xtream" | "stremio";
  url?: string;
  server?: string;
  username?: string;
  password?: string;
  guideUrls?: string[];
  refreshHours: number;
}

export interface TestManifest {
  account: string;
  rev: number;
  profiles: { id: string; rev: number; lists: { id: string; rev: number; keyRev: number }[] }[];
  devices: { id: string; profiles: string[] }[];
}

/** What the server sends one TV. */
export interface DevicePull {
  manifest: Signed;
  /** The profile keys this TV was given, boxed from the owner's box key. */
  profileKeys: { profile: string; key: Sealed }[];
  /** Each profile's name, sealed under the profile key. */
  profiles: { id: string; sealed: Sealed }[];
  /** Each list, sealed under its list key, with that key wrapped for each profile of this TV that has it. */
  lists: { id: string; rev: number; sealed: Sealed; keys: { profile: string; key: Sealed }[] }[];
}

/** A test account: what the TV pulls, plus what the TV would have kept from signing in. */
export interface TestAccount {
  pull: DevicePull;
  device: { id: string; publicKey: string; secretKey: string };
  owner: { signPublicKey: string; boxPublicKey: string };
  expect: { lists: number; profiles: string[]; firstList: string };
}

const PROFILE_NAMES = ["Living room", "Kids", "Guest"];
/** Which test profile has which list: the first every list, the second every other one, the third every fifth. */
const hasList = (profile: number, list: number) => [true, list % 2 === 0, list % 5 === 0][profile];

// Readers for decrypted JSON: a signature or a Poly1305 tag says who wrote
// it, not that it has the right shape.
const record = (value: unknown, what: string) => {
  if (!isRecord(value)) throw new Error(`${what} isn't an object`);
  return value;
};
const text = (value: unknown, what: string) => {
  if (typeof value !== "string") throw new Error(`${what} isn't text`);
  return value;
};
const optionalText = (value: unknown, what: string) => (value === undefined ? undefined : text(value, what));
const count = (value: unknown, what: string) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error(`${what} isn't a count`);
  return value;
};
const array = (value: unknown, what: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${what} isn't a list`);
  return value;
};

const readManifest = (value: unknown): TestManifest => {
  const manifest = record(value, "The manifest");
  return {
    account: text(manifest.account, "The manifest's account"),
    rev: count(manifest.rev, "The manifest's rev"),
    profiles: array(manifest.profiles, "The manifest's profiles").map(item => {
      const profile = record(item, "A manifest profile");
      return {
        id: text(profile.id, "A manifest profile's id"),
        rev: count(profile.rev, "A manifest profile's rev"),
        lists: array(profile.lists, "A manifest profile's lists").map(entry => {
          const listEntry = record(entry, "A manifest list");
          return {
            id: text(listEntry.id, "A manifest list's id"),
            rev: count(listEntry.rev, "A manifest list's rev"),
            keyRev: count(listEntry.keyRev, "A manifest list's keyRev"),
          };
        }),
      };
    }),
    devices: array(manifest.devices, "The manifest's devices").map(item => {
      const device = record(item, "A manifest device");
      return {
        id: text(device.id, "A manifest device's id"),
        profiles: array(device.profiles, "A manifest device's profiles").map(id => text(id, "A profile id")),
      };
    }),
  };
};

const readList = (value: unknown): TestList => {
  const item = record(value, "A list");
  if (item.format !== 1) throw new Error("A list has an unknown format");
  if (item.kind !== "m3u" && item.kind !== "xtream" && item.kind !== "stremio")
    throw new Error("A list has an unknown kind");
  const read: TestList = {
    format: 1,
    id: text(item.id, "A list's id"),
    rev: count(item.rev, "A list's rev"),
    name: text(item.name, "A list's name"),
    kind: item.kind,
    refreshHours: count(item.refreshHours, "A list's refreshHours"),
  };
  for (const key of ["url", "server", "username", "password"] as const) {
    const field = optionalText(item[key], `A list's ${key}`);
    if (field !== undefined) read[key] = field;
  }
  if (item.guideUrls !== undefined)
    read.guideUrls = array(item.guideUrls, "A list's guideUrls").map(url => text(url, "A guide URL"));
  return read;
};

export const makeTestAccount = (listCount = 20): TestAccount => {
  const signing = newSigningKeyPair();
  const ownerBox = newBoxKeyPair();
  const device = newBoxKeyPair();

  const profiles = PROFILE_NAMES.map((name, i) => ({ id: `p${i + 1}`, name, key: newKey() }));

  const lists = Array.from({ length: listCount }, (_, i): TestList => {
    const common = { format: 1 as const, id: `list-${i + 1}`, rev: 1, refreshHours: 24 };
    return i % 2 === 0
      ? {
          ...common,
          name: `Test playlist ${i + 1}`,
          kind: "m3u",
          url: `http://m3u-${i + 1}.example.invalid/playlist.m3u?token=${toBase64(newKey()).slice(0, 24)}`,
          guideUrls: [`http://m3u-${i + 1}.example.invalid/guide.xml.gz`],
        }
      : {
          ...common,
          name: `Test Xtream ${i + 1}`,
          kind: "xtream",
          server: `http://xtream-${i + 1}.example.invalid:8080`,
          username: `user${i + 1}`,
          password: toBase64(newKey()).slice(0, 16),
        };
  });

  const sealedLists = lists.map((list, i) => {
    const key = newKey();
    return {
      id: list.id,
      rev: list.rev,
      sealed: sealJson(key, list),
      keys: profiles
        .filter((_, p) => hasList(p, i))
        .map(profile => ({ profile: profile.id, key: wrapKey(profile.key, key) })),
    };
  });

  const manifest: TestManifest = {
    account: "test-account",
    rev: 1,
    profiles: profiles.map((profile, p) => ({
      id: profile.id,
      rev: 1,
      lists: lists.filter((_, i) => hasList(p, i)).map(list => ({ id: list.id, rev: list.rev, keyRev: 1 })),
    })),
    devices: [{ id: "test-tv", profiles: profiles.map(profile => profile.id) }],
  };

  return {
    pull: {
      manifest: signJson(signing.secretKey, manifest),
      profileKeys: profiles.map(profile => ({
        profile: profile.id,
        key: boxKey(device.publicKey, ownerBox.secretKey, profile.key),
      })),
      profiles: profiles.map(profile => ({
        id: profile.id,
        sealed: sealJson(profile.key, { name: profile.name }),
      })),
      lists: sealedLists,
    },
    device: { id: "test-tv", publicKey: toBase64(device.publicKey), secretKey: toBase64(device.secretKey) },
    owner: { signPublicKey: toBase64(signing.publicKey), boxPublicKey: toBase64(ownerBox.publicKey) },
    expect: { lists: listCount, profiles: PROFILE_NAMES, firstList: lists[0].name },
  };
};

export interface OpenedAccount {
  manifest: TestManifest;
  profiles: { id: string; name: string; lists: TestList[] }[];
}

/**
 * What a TV does with a pull: checks the manifest's signature, opens its
 * profile keys (checking they came from the owner), then each profile's
 * lists, checking each list's revision against the manifest's.
 */
export const openForDevice = (
  pull: DevicePull,
  keys: { deviceSecretKey: Uint8Array; signPublicKey: Uint8Array; boxPublicKey: Uint8Array },
): OpenedAccount => {
  const manifest = readManifest(verifyJson(keys.signPublicKey, pull.manifest));
  const profileKeys = new Map(
    pull.profileKeys.map(entry => [
      entry.profile,
      openBoxedKey(keys.boxPublicKey, keys.deviceSecretKey, entry.key),
    ]),
  );
  const listsById = new Map(pull.lists.map(list => [list.id, list]));

  const profiles = manifest.profiles
    .filter(profile => profileKeys.has(profile.id))
    .map(profile => {
      const profileKey = profileKeys.get(profile.id)!;
      const sealedName = pull.profiles.find(entry => entry.id === profile.id);
      if (!sealedName) throw new Error(`The pull has no name for profile ${profile.id}`);
      const name = text(
        record(openJson(profileKey, sealedName.sealed), "A profile").name,
        "A profile's name",
      );
      const lists = profile.lists.map(entry => {
        const sealed = listsById.get(entry.id);
        const wrapped = sealed?.keys.find(key => key.profile === profile.id);
        if (!sealed || !wrapped) throw new Error(`The pull is missing list ${entry.id}`);
        const opened = readList(openJson(unwrapKey(profileKey, wrapped.key), sealed.sealed));
        if (opened.id !== entry.id || opened.rev !== entry.rev || sealed.rev !== entry.rev)
          throw new Error(`List ${entry.id} isn't the revision the manifest names`);
        return opened;
      });
      return { id: profile.id, name, lists };
    });
  return { manifest, profiles };
};

/** The keys a test account's TV kept, decoded. */
export const testDeviceKeys = (account: TestAccount) => ({
  deviceSecretKey: fromBase64(account.device.secretKey),
  signPublicKey: fromBase64(account.owner.signPublicKey),
  boxPublicKey: fromBase64(account.owner.boxPublicKey),
});
