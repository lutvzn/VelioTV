// Copied from VelioPlatform's packages/sync-core/src/bytes.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// Bytes to and from UTF-8 text and base64, written out by hand so the same
// code runs everywhere sync does: Workers, modern browsers, and TVs back to
// Chromium 38, without TextEncoder, btoa's Latin-1 limit or Buffer.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Uint8Array(128);
// Not .fill(): TypedArray fill arrived in Chromium 45.
for (let i = 0; i < LOOKUP.length; i++) LOOKUP[i] = 255;
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export const toBase64 = (bytes: Uint8Array): string => {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i] << 16;
    out += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}==`;
  } else if (left === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}${ALPHABET[(n >> 6) & 63]}=`;
  }
  return out;
};

/** Reads standard base64 (with or without padding); throws on anything else. */
export const fromBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/=+$/, "");
  if (clean.length % 4 === 1) throw new Error("Not base64: wrong length");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const digit = code < 128 ? LOOKUP[code] : 255;
    if (digit === 255) throw new Error("Not base64: bad character");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 255;
    }
  }
  return out;
};

export const utf8 = (text: string): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    // A surrogate pair is one code point; a lone surrogate becomes U+FFFD.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd;

    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
  }
  return new Uint8Array(out);
};

/** Reads UTF-8; throws on bytes that aren't, as decrypted text that isn't UTF-8 is broken. */
export const fromUtf8 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i];
    let code: number;
    let length: number;
    if (first < 0x80) [code, length] = [first, 1];
    else if (first >= 0xc2 && first < 0xe0) [code, length] = [first & 31, 2];
    else if (first >= 0xe0 && first < 0xf0) [code, length] = [first & 15, 3];
    else if (first >= 0xf0 && first < 0xf5) [code, length] = [first & 7, 4];
    else throw new Error("Not UTF-8");
    if (i + length > bytes.length) throw new Error("Not UTF-8: cut short");
    for (let k = 1; k < length; k++) {
      const next = bytes[i + k];
      if ((next & 0xc0) !== 0x80) throw new Error("Not UTF-8");
      code = (code << 6) | (next & 63);
    }
    const tooLong = (length === 3 && code < 0x800) || (length === 4 && code < 0x10000);
    if (tooLong || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("Not UTF-8");
    if (code >= 0x10000) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
    } else out += String.fromCharCode(code);
    i += length;
  }
  return out;
};
