// Copied from VelioPlatform's packages/sync-core/src/crypto.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// The sealing, wrapping, boxing and signing every Velio platform shares
// (PLAN.md, "Encryption"), on TweetNaCl, which runs on TVs back to
// Chromium 38: no WebCrypto curves, no BigInt, no WebAssembly.
//
// Everything that leaves a device is base64 text inside JSON.

import nacl from "tweetnacl";
import { fromBase64, fromUtf8, toBase64, utf8 } from "./bytes";

export const KEY_BYTES = nacl.secretbox.keyLength;
/** Records are padded to a multiple of this, so their size says little about what's in them. */
export const PAD_TO = 1024;

/** A secretbox or box, as stored and sent. */
export interface Sealed {
  nonce: string;
  box: string;
}

/** A JSON document and an Ed25519 signature over its exact bytes. */
export interface Signed {
  /** The document's UTF-8 JSON, in base64, so the bytes checked are the bytes signed. */
  body: string;
  signature: string;
}

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** A plain object, for reading JSON loosely. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Has the shape of a Sealed; whether it opens is for open() to say. */
export const isSealed = (value: unknown): value is Sealed =>
  isRecord(value) && typeof value.nonce === "string" && typeof value.box === "string";

export class CryptoProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoProblem";
  }
}

export const newKey = (): Uint8Array => nacl.randomBytes(KEY_BYTES);
/** An X25519 key pair, for boxing keys to a device or from the owner. */
export const newBoxKeyPair = (): KeyPair => nacl.box.keyPair();
/** An Ed25519 key pair, for signing the manifest. */
export const newSigningKeyPair = (): KeyPair => nacl.sign.keyPair();

// A 4-byte length, the bytes, then zeros up to a multiple of `padTo`.
const pad = (bytes: Uint8Array, padTo: number) => {
  const length = 4 + bytes.length;
  const padded = new Uint8Array(padTo > 1 ? Math.ceil(length / padTo) * padTo : length);
  padded[0] = bytes.length >>> 24;
  padded[1] = (bytes.length >>> 16) & 255;
  padded[2] = (bytes.length >>> 8) & 255;
  padded[3] = bytes.length & 255;
  padded.set(bytes, 4);
  return padded;
};

const unpad = (padded: Uint8Array) => {
  if (padded.length < 4) throw new CryptoProblem("Sealed data is too short");
  const length = ((padded[0] << 24) | (padded[1] << 16) | (padded[2] << 8) | padded[3]) >>> 0;
  if (length > padded.length - 4) throw new CryptoProblem("Sealed data has a bad length");
  return padded.subarray(4, 4 + length);
};

const checkKey = (key: Uint8Array, length: number, what: string) => {
  if (key.length !== length) throw new CryptoProblem(`${what} must be ${length} bytes`);
};

/**
 * Base64 from outside, at an exact size when given: a CryptoProblem rather
 * than TweetNaCl's own errors, so callers catch one kind.
 */
const bytesOf = (text: string, what: string, length?: number) => {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(text);
  } catch {
    throw new CryptoProblem(`${what} isn't base64`);
  }
  if (length !== undefined && bytes.length !== length)
    throw new CryptoProblem(`${what} must be ${length} bytes`);
  return bytes;
};

/** Encrypts with XSalsa20-Poly1305 under a 32-byte key, padded to `padTo`. */
export const seal = (key: Uint8Array, plain: Uint8Array, padTo = PAD_TO): Sealed => {
  checkKey(key, KEY_BYTES, "A key");
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { nonce: toBase64(nonce), box: toBase64(nacl.secretbox(pad(plain, padTo), nonce, key)) };
};

export const open = (key: Uint8Array, sealed: Sealed): Uint8Array => {
  checkKey(key, KEY_BYTES, "A key");
  const plain = nacl.secretbox.open(
    bytesOf(sealed.box, "A box"),
    bytesOf(sealed.nonce, "A nonce", nacl.secretbox.nonceLength),
    key,
  );
  if (!plain) throw new CryptoProblem("Couldn't decrypt: wrong key, or the data was changed");
  return unpad(plain);
};

export const sealJson = (key: Uint8Array, value: unknown, padTo = PAD_TO) =>
  seal(key, utf8(JSON.stringify(value)), padTo);
export const openJson = (key: Uint8Array, sealed: Sealed): unknown => JSON.parse(fromUtf8(open(key, sealed)));

/** Encrypts one key under another. Keys are all the same size, so they aren't padded. */
export const wrapKey = (wrappingKey: Uint8Array, key: Uint8Array) => seal(wrappingKey, key, 1);
export const unwrapKey = (wrappingKey: Uint8Array, sealed: Sealed) => {
  const key = open(wrappingKey, sealed);
  checkKey(key, KEY_BYTES, "A wrapped key");
  return key;
};

/** Boxes a key from one X25519 key pair to another, so the recipient knows who sent it. */
export const boxKey = (
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
  key: Uint8Array,
): Sealed => {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  return {
    nonce: toBase64(nonce),
    box: toBase64(nacl.box(pad(key, 1), nonce, recipientPublicKey, senderSecretKey)),
  };
};

export const openBoxedKey = (senderPublicKey: Uint8Array, recipientSecretKey: Uint8Array, sealed: Sealed) => {
  checkKey(senderPublicKey, nacl.box.publicKeyLength, "A public key");
  checkKey(recipientSecretKey, nacl.box.secretKeyLength, "A secret key");
  const plain = nacl.box.open(
    bytesOf(sealed.box, "A box"),
    bytesOf(sealed.nonce, "A nonce", nacl.box.nonceLength),
    senderPublicKey,
    recipientSecretKey,
  );
  if (!plain) throw new CryptoProblem("Couldn't open a key: not from the expected sender, or changed");
  const key = unpad(plain);
  checkKey(key, KEY_BYTES, "A boxed key");
  return key;
};

export const signJson = (secretKey: Uint8Array, value: unknown): Signed => {
  const body = utf8(JSON.stringify(value));
  return { body: toBase64(body), signature: toBase64(nacl.sign.detached(body, secretKey)) };
};

/** Checks the signature, then reads the document; throws if it wasn't signed by `publicKey`. */
export const verifyJson = (publicKey: Uint8Array, signed: Signed): unknown => {
  checkKey(publicKey, nacl.sign.publicKeyLength, "A signing key");
  const body = bytesOf(signed.body, "A signed body");
  if (
    !nacl.sign.detached.verify(
      body,
      bytesOf(signed.signature, "A signature", nacl.sign.signatureLength),
      publicKey,
    )
  )
    throw new CryptoProblem("The signature doesn't match");
  return JSON.parse(fromUtf8(body));
};
