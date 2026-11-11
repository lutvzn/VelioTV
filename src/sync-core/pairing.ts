// Copied from VelioPlatform's packages/sync-core/src/pairing.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// Signing in a TV (PLAN.md, "Signing in a TV"). The TV makes a box key pair
// and two pairing secrets: a long one for the QR code and a short one to
// type. Only the TV and the owner's phone know them; the server sees the
// pairing id, ciphertext, and proofs that a phone has a secret.
//
//   QR:     https://velio.tv/pair#K7QM.<22 characters>     (128-bit secret)
//   typed:  K7QM-2XHF-9WRT                                  (40-bit secret)
//
// The TV seals its public key and name under each secret, so the phone
// knows which key to box the profile keys to; a server that swapped in a key
// of its own couldn't seal it. The phone answers with the owner's public keys,
// sealed the same way, so the TV knows whose signatures and boxes to trust.
//
// The typed secret is short enough that a hostile server could try every
// value against the sealed key within days, though not within the
// 10 minutes a pairing lasts on a single computer. The QR code doesn't have
// that weakness.

import nacl from "tweetnacl";
import { toBase64, utf8 } from "./bytes";
import { openJson, sealJson, type Sealed } from "./crypto";
import { id, ReadProblem, record, text } from "./read";

/** Crockford's base32: no I, L, O or U, so a code reads back the same. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_ID_LENGTH = 4;
const CODE_SECRET_LENGTH = 8;
const QR_SECRET_BYTES = 16;
export const PAIRING_MS = 10 * 60_000;
export const MAX_DEVICE_NAME_LENGTH = 40;

export type PairingKind = "qr" | "code";

export interface PairingSecrets {
  /** 16 random bytes, base64url. */
  qr: string;
  /** 8 base32 characters. */
  code: string;
}

/** Random base32; 256 is a multiple of 32, so taking 5 bits of each byte isn't biased. */
const randomCode = (length: number) => {
  const bytes = nacl.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) code += ALPHABET.charAt(bytes[i] & 31);
  return code;
};

const base64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const newPairingId = () => randomCode(PAIRING_ID_LENGTH);

export const newPairingSecrets = (): PairingSecrets => ({
  qr: base64Url(nacl.randomBytes(QR_SECRET_BYTES)),
  code: randomCode(CODE_SECRET_LENGTH),
});

export const pairingKey = (kind: PairingKind, secret: string) =>
  nacl.hash(utf8(`velio pairing ${kind}\n${secret}`)).subarray(0, nacl.secretbox.keyLength);

/**
 * Shows the server that a phone has the secret, without giving it the key:
 * the server answers the sealed details, and takes a sign-in, only for the
 * right proof, so other accounts can't fetch a TV's details by its id and
 * guess its code offline. (The server itself can still guess a typed code;
 * see above.)
 */
export const pairingProof = (kind: PairingKind, secret: string) =>
  toBase64(nacl.hash(utf8(`velio pairing proof ${kind}\n${secret}`)).subarray(0, 32));

export const pairingProofs = (secrets: PairingSecrets): Record<PairingKind, string> => ({
  qr: pairingProof("qr", secrets.qr),
  code: pairingProof("code", secrets.code),
});

/** The QR code's address. */
export const pairingUrl = (site: string, pairingId: string, secrets: PairingSecrets) =>
  `${site}/pair#${pairingId}.${secrets.qr}`;

/** The code to type, such as K7QM-2XHF-9WRT. */
export const pairingCode = (pairingId: string, secrets: PairingSecrets) =>
  `${pairingId}-${secrets.code.slice(0, 4)}-${secrets.code.slice(4)}`;

export interface ReadCode {
  id: string;
  kind: PairingKind;
  secret: string;
}

/** Reads a QR address, its fragment, or a typed code, forgiving case, spaces and look-alike letters. */
export const readPairingCode = (input: string): ReadCode | null => {
  const trimmed = input.trim();
  const hash = trimmed.indexOf("#") >= 0 ? trimmed.slice(trimmed.indexOf("#") + 1) : trimmed;
  const qr = /^([0-9A-Za-z]{4})\.([A-Za-z0-9_-]{22})$/.exec(hash);
  if (qr) return { id: qr[1].toUpperCase(), kind: "qr", secret: qr[2] };
  const typed = hash.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (/^[0-9A-HJKMNP-TV-Z]{12}$/.test(typed))
    return { id: typed.slice(0, PAIRING_ID_LENGTH), kind: "code", secret: typed.slice(PAIRING_ID_LENGTH) };
  return null;
};

export const PAIRING_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}$/;

// --- What the TV sends: its key and name, sealed under each secret, and the proofs ---

export interface DeviceInfo {
  format: 1;
  /** The TV's box public key, base64. */
  publicKey: string;
  name: string;
}

export type SealedDeviceInfo = Record<PairingKind, Sealed>;

export const sealDeviceInfo = (secrets: PairingSecrets, info: DeviceInfo): SealedDeviceInfo => ({
  qr: sealJson(pairingKey("qr", secrets.qr), info, 256),
  code: sealJson(pairingKey("code", secrets.code), info, 256),
});

/** The body of POST /v1/pair. */
export interface PairRequest {
  publicKey: string;
  name: string;
  sealed: SealedDeviceInfo;
  proofs: Record<PairingKind, string>;
}

export const pairRequest = (secrets: PairingSecrets, info: DeviceInfo): PairRequest => ({
  publicKey: info.publicKey,
  name: info.name,
  sealed: sealDeviceInfo(secrets, info),
  proofs: pairingProofs(secrets),
});

const readPublicKey = (value: unknown, what: string) => {
  const key = text(value, what, 44);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new ReadProblem(`${what} isn't a public key`);
  return key;
};

export const openDeviceInfo = (code: ReadCode, sealed: SealedDeviceInfo): DeviceInfo => {
  const item = record(openJson(pairingKey(code.kind, code.secret), sealed[code.kind]), "The TV's details");
  if (item.format !== 1) throw new ReadProblem("The TV's details have an unknown format");
  return {
    format: 1,
    publicKey: readPublicKey(item.publicKey, "The TV's key"),
    name: text(item.name, "The TV's name", MAX_DEVICE_NAME_LENGTH),
  };
};

// --- What the phone sends back: whose keys to trust ---

export interface PairingPayload {
  format: 1;
  account: string;
  /** The TV's id in the account's manifest. */
  device: string;
  /** The TV's own key, as the phone boxed the profile keys to it. */
  devicePublicKey: string;
  signPublicKey: string;
  boxPublicKey: string;
}

export const sealPairingPayload = (code: ReadCode, payload: PairingPayload) =>
  sealJson(pairingKey(code.kind, code.secret), payload, 512);

/** Opens what the phone sent, and checks it's for this TV's key. */
export const openPairingPayload = (
  kind: PairingKind,
  secrets: PairingSecrets,
  sealed: Sealed,
  devicePublicKey: string,
): PairingPayload => {
  const item = record(openJson(pairingKey(kind, secrets[kind]), sealed), "The sign-in");
  if (item.format !== 1) throw new ReadProblem("The sign-in has an unknown format");
  const payload: PairingPayload = {
    format: 1,
    account: text(item.account, "The account", 64),
    device: id(item.device, "The TV's id"),
    devicePublicKey: readPublicKey(item.devicePublicKey, "The TV's key"),
    signPublicKey: readPublicKey(item.signPublicKey, "The owner's signing key"),
    boxPublicKey: readPublicKey(item.boxPublicKey, "The owner's box key"),
  };
  if (payload.devicePublicKey !== devicePublicKey)
    throw new ReadProblem("The sign-in is for another TV's key");
  return payload;
};
