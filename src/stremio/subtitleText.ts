// A subtitle file's text (PLAN.md, "Stremio add-ons", step 6): its bytes
// read in the character set the file is most likely in, by its language
// or else by what's in it; text that was read the wrong way somewhere
// before ("â€™" for "’") put right; and, if the profile chose, sound
// descriptions such as "[music]" or "JOHN:" taken out of each line.
//
// Adapted from NuvioTVSmart (https://github.com/NuvioMedia/NuvioTVSmart,
// GPL-3.0): js/core/player/subtitleCharsetDetector.js,
// js/core/player/subtitleMojibakeSanitizer.js and
// js/core/player/subtitleSdhFilter.js. Changed: rewritten in TypeScript;
// loops by character code, with no Array.from or codePointAt, for older
// TVs; sound descriptions are taken out of a cue's plain text, as the app
// draws no styling; Stremio's "pob" counts as Portuguese.

const MAX_SAMPLE_BYTES = 4096;

const WESTERN = [
  "por",
  "pt",
  "pob",
  "spa",
  "spn",
  "esp",
  "es",
  "fra",
  "fre",
  "fr",
  "deu",
  "ger",
  "de",
  "ita",
  "it",
  "nld",
  "dut",
  "nl",
  "eng",
  "en",
  "dan",
  "da",
  "swe",
  "sv",
  "nor",
  "no",
  "nob",
  "nno",
  "fin",
  "fi",
  "cat",
  "ca",
  "glg",
  "gl",
  "eus",
  "baq",
  "eu",
];
const CYRILLIC = ["rus", "ru", "ukr", "uk", "bel", "be", "bul", "bg", "mkd", "mk", "srp", "sr"];
const BY_LANGUAGE: Record<string, string> = {
  heb: "windows-1255",
  he: "windows-1255",
  iw: "windows-1255",
  ara: "windows-1256",
  ar: "windows-1256",
  ell: "windows-1253",
  el: "windows-1253",
  gre: "windows-1253",
  tur: "windows-1254",
  tr: "windows-1254",
  tha: "windows-874",
  th: "windows-874",
  vie: "windows-1258",
  vi: "windows-1258",
  pol: "windows-1250",
  pl: "windows-1250",
  ces: "windows-1250",
  cs: "windows-1250",
  cze: "windows-1250",
  hun: "windows-1250",
  hu: "windows-1250",
  slv: "windows-1250",
  sl: "windows-1250",
  hrv: "windows-1250",
  hr: "windows-1250",
  ron: "windows-1250",
  ro: "windows-1250",
  rum: "windows-1250",
  slk: "windows-1250",
  sk: "windows-1250",
  jpn: "shift_jis",
  ja: "shift_jis",
  kor: "euc-kr",
  ko: "euc-kr",
};

const normalized = (language: string) => language.trim().toLowerCase().replace(/_/g, "-");
const baseOf = (language: string) => normalized(language).split("-")[0] ?? "";

/** The character set a file in `language` is most likely in, when it isn't UTF-8. */
export const charsetOfLanguage = (language: string): string | undefined => {
  const full = normalized(language);
  const base = baseOf(language);
  if (WESTERN.includes(base)) return "windows-1252";
  if (CYRILLIC.includes(base)) return "windows-1251";
  if (base === "zho" || base === "zh" || base === "chi") {
    if (/(^|-)(tw|hk)(-|$)|traditional|hant/.test(full)) return "big5";
    if (/(^|-)(cn|sg)(-|$)|simplified|hans/.test(full)) return "gb18030";
    return undefined;
  }
  return BY_LANGUAGE[base];
};

const decode = (bytes: Uint8Array, charset: string, fatal = false) => {
  try {
    return new TextDecoder(charset, { fatal }).decode(bytes, { stream: fatal });
  } catch {
    return undefined;
  }
};

export const isUtf8 = (bytes: Uint8Array) => {
  const trail = (at: number) => at < bytes.length && (bytes[at] & 0xc0) === 0x80;
  let at = 0;
  while (at < bytes.length) {
    const first = bytes[at++];
    if (first <= 0x7f) continue;
    const more =
      first >= 0xc2 && first <= 0xdf
        ? 1
        : first >= 0xe0 && first <= 0xef
          ? 2
          : first >= 0xf0 && first <= 0xf4
            ? 3
            : -1;
    if (more < 0) return false;
    for (let i = 0; i < more; i++) if (!trail(at++)) return false;
  }
  return true;
};

/** How many characters of `text` have codes in [low, high]. */
const countIn = (text: string | undefined, low: number, high: number) => {
  let count = 0;
  if (text)
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= low && code <= high) count++;
    }
  return count;
};

const countBytes = (bytes: Uint8Array, test: (byte: number, at: number) => boolean) => {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) if (test(bytes[i], i)) count++;
  return count;
};

const oneOf = (list: number[]) => (byte: number) => list.indexOf(byte) >= 0;
const TURKISH = oneOf([0xf0, 0xfe, 0xfd, 0xd0, 0xde, 0xdd]);
const CENTRAL = oneOf([
  0xb9, 0xb3, 0x9c, 0x9f, 0x9a, 0x9e, 0x8c, 0x8f, 0x8a, 0x8e, 0x8d, 0x9d, 0xcf, 0xef, 0xbe,
]);
const VIETNAMESE = oneOf([0xcc, 0xd2, 0xf2, 0xf5]);
const RUSSIAN = oneOf([0xee, 0xe0, 0xe5, 0xe8, 0xff, 0xfb, 0xf3, 0xfd, 0xfe]);
const KOI8 = oneOf([0xcf, 0xc1, 0xc5, 0xc9, 0xd5, 0xdf]);
const GREEK = oneOf([
  0xe1, 0xef, 0xe5, 0xe7, 0xfd, 0xfe, 0xe9, 0xf5, 0xf9, 0xdc, 0xdd, 0xde, 0xdf, 0xfa, 0xfb, 0xfc,
]);

/** The character set a file that isn't UTF-8 is most likely in, by its bytes. */
export const guessCharset = (bytes: Uint8Array): string => {
  let first = 0;
  while (first < bytes.length && bytes[first] < 0x80) first++;
  if (first >= bytes.length) return "utf-8";
  const begin = Math.max(0, first - 100);
  const sample = bytes.subarray(begin, begin + MAX_SAMPLE_BYTES);
  let letters = 0;
  let high = 0;
  let run = 0;
  let longest = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)) {
      letters++;
      run = 0;
    } else if (byte >= 0x80) {
      high++;
      run++;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  const next = (at: number) => sample[at + 1] ?? 0;

  const hiragana = countBytes(sample, (byte, at) => byte === 0x82 && next(at) >= 0x9f && next(at) <= 0xf1);
  if (hiragana >= 2) return "shift_jis";
  const hangul = countIn(decode(sample, "euc-kr", true), 0xac00, 0xd7af);
  const hanzi = countIn(decode(sample, "gb18030", true), 0x3400, 0x9fff);
  if (hangul >= 4 && hangul >= hanzi && longest >= 4) return "euc-kr";
  const thai = countBytes(sample, byte => byte >= 0xa1 && byte <= 0xbf);
  if (thai >= 4 && thai * 4 >= high) return "windows-874";
  if (hanzi >= 4 && longest >= 6) {
    const big5Trail = countBytes(
      sample,
      (byte, at) => byte >= 0xa1 && byte <= 0xf9 && next(at) >= 0x40 && next(at) <= 0x7e,
    );
    const big5 = decode(sample, "big5");
    return big5Trail >= 2 && big5 !== undefined && big5.indexOf("\ufffd") < 0 ? "big5" : "gb18030";
  }

  // Mostly Latin letters: one of the European sets.
  if (letters >= high || longest <= 2) {
    const turkish = countBytes(sample, TURKISH);
    const central = countBytes(sample, CENTRAL);
    const vietnamese = countBytes(sample, VIETNAMESE);
    if (turkish >= 2 && turkish > central) return "windows-1254";
    if (central >= 2 && central >= vietnamese) return "windows-1250";
    if (vietnamese >= 2) return "windows-1258";
    return "windows-1252";
  }

  const hebrew = countBytes(sample, byte => byte >= 0xe0 && byte <= 0xfa);
  const upper = countBytes(sample, byte => byte >= 0xc0 && byte <= 0xdf);
  const arabicAl = countBytes(sample, (byte, at) => byte === 0xc7 && next(at) === 0xe1);
  const russian = countBytes(sample, RUSSIAN);
  const koi8 = countBytes(sample, KOI8);
  const greek = countBytes(sample, GREEK);
  if (hebrew === high && hebrew >= 4 && upper === 0) return "windows-1255";
  if (thai >= 4 && thai * 4 >= high) return "windows-874";
  if (arabicAl > 0) return "windows-1256";
  if (koi8 > russian && koi8 >= 3) return "koi8-r";
  if (russian > greek && russian >= 4) return "windows-1251";
  if (greek > russian && greek >= 4) return "windows-1253";
  return "windows-1252";
};

const latin1Bytes = (text: string) => {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return undefined;
    bytes[i] = code;
  }
  return bytes;
};

/** For the languages whose text is often found read as Latin-1: their set and letters. */
const SCRIPTS: [string[], string, number, number][] = [
  [["heb", "he", "iw"], "windows-1255", 0x590, 0x5ff],
  [["ara", "ar"], "windows-1256", 0x600, 0x6ff],
  [["ell", "el", "gre"], "windows-1253", 0x370, 0x3ff],
  [["rus", "ru", "ukr", "uk"], "windows-1251", 0x400, 0x4ff],
];

/**
 * Text in Hebrew, Arabic, Greek or Russian that was once read as Latin-1
 * and saved again as UTF-8, read back in its own set.
 */
const repairTwiceEncoded = (text: string, language: string) => {
  if (!text) return text;
  const bytes = latin1Bytes(text);
  if (!bytes) return text;
  const base = baseOf(language);
  const script = SCRIPTS.find(([names]) => names.includes(base));
  if (script) {
    const [, charset, low, high] = script;
    if (countIn(text, 0xe0, 0xfa) < 5) return text;
    const read = decode(bytes, charset);
    return read && countIn(read, low, high) > 0 ? read : text;
  }
  // No language given: Hebrew is the one often seen this way.
  const words = text.split(/\s+/).filter(word => word.length >= 2);
  const garbled = words.filter(word => /^(?:[\u00e0-\u00fa]|[<i/>,.!?:'"\\_()-])+$/.test(word));
  if (garbled.length < 5 || garbled.length * 3 < words.length) return text;
  const read = decode(bytes, "windows-1255");
  return read && countIn(read, 0x590, 0x5ff) >= 10 ? read : text;
};

/** Longer ones before their shorter beginnings. */
const MOJIBAKE: [string, string][] = [
  ["\u00e2\u2122\u00aa", "\u266a"],
  ["\u00e2\u2122\u00ab", "\u266b"],
  ["\u00e2\u20ac\u2122", "\u2019"],
  ["\u00e2\u20ac\u02dc", "\u2018"],
  ["\u00e2\u20ac\u0153", "\u201c"],
  ["\u00e2\u20ac\u009d", "\u201d"],
  ["\u00e2\u20ac\u009c", "\u201c"],
  ["\u00e2\u20ac\u0098", "\u2018"],
  ["\u00e2\u20ac\u0099", "\u2019"],
  ["\u00e2\u20ac\u201c", "\u2013"],
  ["\u00e2\u20ac\u201d", "\u2014"],
  ["\u00e2\u20ac\u00a6", "\u2026"],
  ["\u00c2\u00a0", " "],
  ["\u00c2\u00bf", "\u00bf"],
  ["\u00c2\u00a1", "\u00a1"],
  ["\u00c2\u00ab", "\u00ab"],
  ["\u00c2\u00bb", "\u00bb"],
  ["\u00c2 ", " "],
  ["\u00e2\u2122", "\u266a"],
  ["\u00e2\u20ac", "\u201d"],
  ["\ufffd", ""],
];

/** "â€™" back to "’", and the like: UTF-8 text once read as Windows-1252. */
export const repairMojibake = (text: string) => {
  if (!/[\u00e2\u00c2\ufffd]/.test(text)) return text;
  let repaired = text;
  for (const [garbled, meant] of MOJIBAKE)
    if (repaired.indexOf(garbled) >= 0) repaired = repaired.split(garbled).join(meant);
  return repaired;
};

/**
 * A subtitle file's text, from its bytes: by its byte order mark, as UTF-8
 * if it is, or else in its language's usual set, or the one its bytes
 * look like.
 */
export const decodeSubtitles = (buffer: ArrayBuffer, language = "") => {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) return "";
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = decode(bytes.subarray(2), "utf-16le") ?? "";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = decode(bytes.subarray(2), "utf-16be") ?? "";
  else {
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const body = bom ? bytes.subarray(3) : bytes;
    const charset = bom || isUtf8(body) ? "utf-8" : (charsetOfLanguage(language) ?? guessCharset(body));
    text = repairTwiceEncoded(decode(body, charset) ?? decode(body, "utf-8") ?? "", language);
  }
  return repairMojibake(text);
};

// Sound descriptions: "[music]", "(DOOR SLAMS)", ">>", and speakers' names
// before a colon, when they look like labels rather than speech.
const BRACKETS = /\[[^\]]*\][ \t]*/g;
const CHEVRONS = /[<>]{2,}[ \t]*/g;
const PARENTHESES =
  /(?:\((?=[A-Za-z0-9 '#.,"\\\-\n]*\))(?![0-9]*\))[^)]*\)|（(?=[A-Za-z0-9 '#.,"\\\-\n]*）)(?![0-9]*）)[^）]*）)[ \t]*/g;
const SPEAKER = /^([ \t]*-[ \t]*)?([A-Za-z0-9 ()'#.,]+|\[[^\]\n]*\]):(?=\s|$)[ \t]*/gm;

/** Whether "JOHN" or "Man 2" before a colon names a speaker, not words of the line. */
export const isSpeakerLabel = (label: string, textFollows: boolean) => {
  if (label.charAt(0) === "[") return true;
  if (!/[A-Za-z]/.test(label)) return false;
  if (!/[a-z]/.test(label)) return true;
  if (!textFollows) return false;
  const words = label.trim().split(/[ \t]+/);
  return words.length <= 3 && words.every(word => !/^[a-z]/.test(word));
};

/** A cue's plain text without its sound descriptions; empty if that was all it had. */
export const withoutSoundText = (text: string) => {
  let rest = text.replace(/\r\n?/g, "\n").replace(CHEVRONS, "");
  rest = rest.replace(
    SPEAKER,
    (whole: string, dash: string | undefined, label: string, at: number, all: string) => {
      const follows = (all.slice(at + whole.length).split("\n")[0] ?? "").trim().length > 0;
      return isSpeakerLabel(label, follows) ? (dash ?? "") : whole;
    },
  );
  rest = rest.replace(BRACKETS, "").replace(PARENTHESES, "");
  return rest
    .split("\n")
    .filter(line => /[^\s-]/.test(line))
    .join("\n");
};
