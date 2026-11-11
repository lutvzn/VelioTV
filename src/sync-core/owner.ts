// Copied from VelioPlatform's packages/sync-core/src/owner.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// The owner's keys (PLAN.md, "Keys"): the account key, which opens every
// profile and list key, and the signing and box key pairs. They are made at
// sign-up, on the owner's device, and kept on the server only as the owner
// bundle, sealed under the unlock key from the password.

import nacl from "tweetnacl";
import { fromBase64, toBase64 } from "./bytes";
import { CryptoProblem, isRecord, KEY_BYTES, newKey, openJson, sealJson, type Sealed } from "./crypto";

export interface OwnerKeys {
  accountKey: Uint8Array;
  signing: { publicKey: Uint8Array; secretKey: Uint8Array };
  box: { publicKey: Uint8Array; secretKey: Uint8Array };
}

/** The halves the server and TVs may hold, in base64. */
export interface OwnerPublicKeys {
  signPublicKey: string;
  boxPublicKey: string;
}

export const newOwnerKeys = (): OwnerKeys => ({
  accountKey: newKey(),
  signing: nacl.sign.keyPair(),
  box: nacl.box.keyPair(),
});

export const ownerPublicKeys = (owner: OwnerKeys): OwnerPublicKeys => ({
  signPublicKey: toBase64(owner.signing.publicKey),
  boxPublicKey: toBase64(owner.box.publicKey),
});

/** The owner's secret halves, as JSON: what the owner bundle seals, and what a remembering browser keeps. */
export const ownerSecrets = (owner: OwnerKeys) => ({
  format: 1,
  accountKey: toBase64(owner.accountKey),
  signSecretKey: toBase64(owner.signing.secretKey),
  boxSecretKey: toBase64(owner.box.secretKey),
});

export const sealOwnerBundle = (unlockKey: Uint8Array, owner: OwnerKeys): Sealed =>
  sealJson(unlockKey, ownerSecrets(owner));

// A loop, not .every(): TypedArray methods arrived in Chromium 45.
const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Reads ownerSecrets() back. With the public keys the server holds, also
 * checks that the secret keys are their other halves, so a server can't pair
 * a bundle with keys of its own.
 */
export const ownerFromSecrets = (secrets: unknown, expected?: OwnerPublicKeys): OwnerKeys => {
  if (!isRecord(secrets) || secrets.format !== 1) throw new CryptoProblem("Not an owner bundle");
  const read = (key: string, length: number) => {
    const value = secrets[key];
    if (typeof value !== "string") throw new CryptoProblem(`The owner bundle has no ${key}`);
    const bytes = fromBase64(value);
    if (bytes.length !== length) throw new CryptoProblem(`The owner bundle's ${key} has the wrong size`);
    return bytes;
  };
  const accountKey = read("accountKey", KEY_BYTES);
  const signing = nacl.sign.keyPair.fromSecretKey(read("signSecretKey", nacl.sign.secretKeyLength));
  const box = nacl.box.keyPair.fromSecretKey(read("boxSecretKey", nacl.box.secretKeyLength));
  const owner = { accountKey, signing, box };
  if (expected) {
    const actual = ownerPublicKeys(owner);
    if (
      !sameBytes(fromBase64(expected.signPublicKey), fromBase64(actual.signPublicKey)) ||
      !sameBytes(fromBase64(expected.boxPublicKey), fromBase64(actual.boxPublicKey))
    )
      throw new CryptoProblem("The owner bundle doesn't match the account's public keys");
  }
  return owner;
};

/** Opens the owner bundle with the unlock key, checked against the public keys as ownerFromSecrets() does. */
export const openOwnerBundle = (
  unlockKey: Uint8Array,
  sealed: Sealed,
  expected?: OwnerPublicKeys,
): OwnerKeys => ownerFromSecrets(openJson(unlockKey, sealed), expected);
