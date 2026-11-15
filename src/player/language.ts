// Streams name a track's language with two letters ("de") or three ("deu",
// or the older "ger"), and AVPlay passes on whichever the stream has. These
// helpers treat them as one language, and name it for the UI.

// Three-letter codes for the two-letter ones live streams use most.
const TWO_LETTERS: Record<string, string> = {
  ara: "ar",
  bul: "bg",
  ces: "cs",
  cze: "cs",
  dan: "da",
  deu: "de",
  ger: "de",
  ell: "el",
  gre: "el",
  eng: "en",
  spa: "es",
  fas: "fa",
  per: "fa",
  fin: "fi",
  fra: "fr",
  fre: "fr",
  heb: "he",
  hin: "hi",
  hrv: "hr",
  hun: "hu",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  nld: "nl",
  dut: "nl",
  nor: "no",
  pol: "pl",
  por: "pt",
  ron: "ro",
  rum: "ro",
  rus: "ru",
  slk: "sk",
  slo: "sk",
  srp: "sr",
  swe: "sv",
  tur: "tr",
  ukr: "uk",
  zho: "zh",
  chi: "zh",
};

/** A language code in one form, so "deu", "ger" and "de-DE" are all "de". */
export const languageKey = (code: string | undefined) => {
  const base = (code ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return TWO_LETTERS[base] ?? base;
};

export const sameLanguage = (a: string | undefined, b: string | undefined) =>
  languageKey(a) !== "" && languageKey(a) === languageKey(b);

interface DisplayNames {
  of(code: string): string | undefined;
}
type DisplayNamesClass = new (locales: string[], options: { type: "language" }) => DisplayNames;

let names: DisplayNames | null | undefined;
const displayNames = () => {
  if (names !== undefined) return names;
  // Not in the ES2019 library types, and missing on older TVs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const DisplayNamesOf = Reflect.get(Intl, "DisplayNames") as DisplayNamesClass | undefined;
  try {
    names = DisplayNamesOf ? new DisplayNamesOf(["en"], { type: "language" }) : null;
  } catch {
    names = null;
  }
  return names;
};

/** A language's name in English, such as "German", or the code itself if unknown. */
export const languageName = (code: string | undefined) => {
  const key = languageKey(code);
  if (!key) return undefined;
  try {
    const name = displayNames()?.of(key);
    if (name && name.toLowerCase() !== key) return name;
  } catch {
    // Not a code it knows.
  }
  return key.toUpperCase();
};
