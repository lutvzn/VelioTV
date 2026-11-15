// Cinemeta, Stremio's own add-on for films' and series' details, built in
// for the modern Movies and Series pages (PLAN.md, "Movies and Series by
// title"): a source's title name, cleaned, is searched for there, and the
// result with the same name and year gives its IMDb id and genres.

import { fold } from "../guide/search";
import type { AddonMeta } from "./addon";

export const CINEMETA_URL = "https://v3-cinemeta.strem.io/manifest.json";

/**
 * Tags before a name, such as "EN - ", "|EN| ", "[4K] " or "KU-B--" (a name
 * with hyphens for spaces). A tag has a letter, so a title's number stays,
 * as in "2001: A Space Odyssey" or "300: Rise of an Empire".
 */
const LEADING_TAGS =
  /^(?:\s*(?:\[[^\]]{1,12}\]|\|[^|]{1,12}\||(?=[0-9]*[A-Z])[A-Z0-9]{2,4}\s*[-:|]\s+|[A-Z]{2}:|[A-Z]{2,4}(?:-[A-Z])?--(?=[A-Za-z0-9])))+/;
/** The first tag's letters, as above. */
const FIRST_TAG =
  /^\s*(?:\[([A-Za-z]{2,4})\]|\|([A-Za-z]{2,4})\||([A-Z]{2,4})(?:-[A-Z])?(?:\s*[-:|]\s|:|--))/;
/** Tags' languages, as TMDB names them. */
const TAG_LANGUAGES: Record<string, string> = {
  AR: "ar",
  BR: "pt-BR",
  CZ: "cs",
  DE: "de",
  DK: "da",
  EN: "en",
  ES: "es",
  FI: "fi",
  FR: "fr",
  GER: "de",
  GR: "el",
  HU: "hu",
  IT: "it",
  KRD: "ku",
  KU: "ku",
  NL: "nl",
  NO: "no",
  PL: "pl",
  PT: "pt",
  RO: "ro",
  RU: "ru",
  SE: "sv",
  SOM: "so",
  TR: "tr",
};

/** The language a provider's tag gives, as "ES - " or "|TR|" does, on a name or a category. */
export const tagLanguage = (text: string | undefined) => {
  const tag = text ? FIRST_TAG.exec(text) : null;
  const letters = tag ? (tag[1] ?? tag[2] ?? tag[3] ?? "").toUpperCase() : "";
  return TAG_LANGUAGES[letters];
};

/** Arabic, Hebrew or Cyrillic after a name in Latin letters: the name again, in another language. */
const OTHER_SCRIPT =
  /^(.*[A-Za-z0-9].*?)\s+[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF][\s\S]*$/;
/** Quality and language words at the end, which providers add. */
const TRAILING_WORDS =
  /(?:[\s\-_.|]+(?:4k|uhd|fhd|hd|sd|hq|2160p|1080p|720p|480p|hevc|h264|h265|x264|x265|hdr|hdr10|dv|multi|dual|vostfr|vost|subs?|dubbed|dub|leg|legendado|dublado|nf|amzn|web|webrip|web-dl|bluray|remux))+\s*$/i;
const BRACKETS = /\s*[[(][^\])]*[\])]\s*/g;

const FIRST_YEAR = /\b(?:19|20)\d\d\b/;

const tidy = (text: string) => text.replace(/\s+/g, " ").replace(/^[\s\-:|]+|[\s\-:|]+$/g, "");

/** Another name to search for, when the cleaned one finds nothing. */
export interface OtherName {
  title: string;
  year?: number;
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];

/**
 * Names that may be the title, for one a provider writes its own way:
 * after the franchise's, as "Avengers 2 Age Of Ultron" or "Batman: The Dark
 * Knight", or numbered when it's the first, as "A Quiet Place 1".
 */
const otherNames = (title: string) => {
  const names: string[] = [];
  const colon = title.lastIndexOf(": ");
  if (colon > 0) names.push(title.slice(colon + 2));
  const numbered = /^(.+?) [1-9] (.+)$/.exec(title.replace(/: /g, " "));
  if (numbered) names.push(numbered[2], `${numbered[1]} ${numbered[2]}`);
  const first = /^(.+) 1$/.exec(title);
  if (first) names.push(first[1]);
  // Sequels, as Cinemeta names many: "Bad Boys II", "Back to the Future Part II".
  const sequel = /^(.+) ([2-9])$/.exec(title);
  if (sequel) {
    const roman = ROMAN[Number(sequel[2])];
    names.push(`${sequel[1]} ${roman}`, `${sequel[1]} Part ${roman}`, `${sequel[1]} Part ${sequel[2]}`);
  }
  if (!/^(?:the|an?) /i.test(title)) names.push(`The ${first ? first[1] : title}`);
  return names;
};

/** A name with hyphens for spaces, such as "Batman--The-Dark-Knight (2008)": "---" is "&" and "--" ": ". */
const unhyphen = (name: string) =>
  /\s/.test(name.replace(BRACKETS, "").trim()) || !name.includes("-")
    ? name
    : name.replace(/---/g, " & ").replace(/--/g, ": ").replace(/-s-/g, "'s ").replace(/-/g, " ");

/** A provider's name for a film or series, as the title alone and its year. */
export const cleanTitle = (name: string, given?: number) => {
  const latin = OTHER_SCRIPT.exec(name);
  let title = unhyphen((latin ? latin[1] : name).replace(LEADING_TAGS, ""));
  // The year: in brackets, or the last word once quality words are gone.
  const inBrackets = /[[(]\s*(19\d\d|20\d\d)\s*[\])]/.exec(title)?.[1];
  title = title.replace(BRACKETS, " ").replace(/[_.]+/g, " ");
  // A year that is the first year-like number in the name may be one read
  // from the title's own number, as imports before nameYear() read "Blade
  // Runner 2049 (2017)" or "1917 2019" (src/data/vod.ts): then
  // the name's own year is taken, as when none is given. One the name
  // doesn't hold, as from an Xtream year field, stays.
  const year = given !== undefined && FIRST_YEAR.exec(name)?.[0] === String(given) ? undefined : given;
  const dropWords = () => {
    for (let i = 0; i < 3; i++) title = title.replace(TRAILING_WORDS, "");
  };
  dropWords();
  let atEnd: string | undefined;
  /** The name with the number at its end, which may be the title's own, as in "Blade Runner 2049". */
  let whole: string | undefined;
  const last = inBrackets ? undefined : /^(.*\S)\s+((?:19|20)\d\d)\s*$/.exec(title.trim());
  // With the year known, a number further from it is the title's own, as "Blade Runner 2049" of 2017.
  if (last && (year === undefined || Math.abs(Number(last[2]) - year) <= 1)) {
    whole = tidy(title);
    title = last[1];
    atEnd = last[2];
    dropWords();
  }
  title = tidy(title) || name.trim();
  const found = inBrackets ?? atEnd;
  const clean: { title: string; year?: number; others: OtherName[] } = {
    title,
    year: year ?? (found ? Number(found) : undefined),
    others: [],
  };
  const seen = new Set([nameKey(title)]);
  // Guessed names only with a year, which the result must have too.
  const known = clean.year;
  for (const other of known === undefined ? [] : otherNames(title)) {
    const key = nameKey(other);
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    clean.others.push({ title: other, year: known });
  }
  // The whole name first: the number taken as the year may be the title's own.
  if (whole && year === undefined && !seen.has(nameKey(whole))) clean.others.unshift({ title: whole });
  return clean;
};

/**
 * How names are cleaned: titles that found nothing are looked for again
 * when it goes up, as they may now be found.
 */
export const CLEANING = 8;

/** A name to compare: folded, "&" as "and", letters and digits only. */
export const nameKey = (name: string) =>
  fold(name)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "");

/**
 * The search result that is this title: the same name, and a year no more
 * than one off when both have one. With several, the nearest year, then
 * the first. None when no name is the same, so two films aren't joined by
 * a guess. `strict`, for a name guessed from the provider's: both need a
 * year.
 */
export const pickMatch = (found: readonly AddonMeta[], title: string, year?: number, strict = false) => {
  const wanted = nameKey(title);
  if (!wanted) return undefined;
  const same = found.filter(meta => nameKey(meta.name) === wanted);
  if (year === undefined) return strict ? undefined : same[0];
  let best: AddonMeta | undefined;
  let bestOff = 2;
  for (const meta of same) {
    // Strict: a result with no year isn't taken, as for a name only guessed at.
    const off = meta.year === undefined ? (strict ? 2 : 1.5) : Math.abs(meta.year - year);
    if (off < bestOff) {
      best = meta;
      bestOff = off;
    }
  }
  return best;
};

/** Whether an id is IMDb's, which Cinemeta and most add-ons share. */
export const isImdbId = (id: string) => /^tt\d+$/.test(id);
