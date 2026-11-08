// The languages the app is translated into (PLAN.md, Phase 8, step 5), and
// how one is picked for the TV's own language.

/** Each language's name in that language, as the language setting lists them. */
export const LANGUAGE_NAMES = {
  en: "English",
  "pt-BR": "Português (Brasil)",
} as const;

export type Language = keyof typeof LANGUAGE_NAMES;
export const LANGUAGES: readonly Language[] = ["en", "pt-BR"];
/** The setting: a language, or "auto" for the TV's own. */
export type LanguageSetting = Language | "auto";

export const isLanguage = (value: unknown): value is Language =>
  typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);

const tidy = (tag: string) => tag.replace(/_/g, "-").toLowerCase();
const base = (tag: string) => tidy(tag).split("-")[0];

/**
 * The language to show for the TV's languages, best first: for the first
 * one the app has, that language exactly ("pt-BR") or one of the same
 * language ("pt-PT" gets "pt-BR"); English if it has none.
 */
export const matchLanguage = (wanted: readonly string[]): Language => {
  for (const tag of wanted) {
    const found =
      LANGUAGES.find(ours => tidy(ours) === tidy(tag)) ?? LANGUAGES.find(ours => base(ours) === base(tag));
    if (found) return found;
  }
  return "en";
};

/** The TV's languages, best first. */
export const tvLanguages = (): readonly string[] =>
  typeof navigator === "undefined"
    ? []
    : navigator.languages?.length
      ? navigator.languages
      : [navigator.language];

/**
 * "one" or "other" (or another of the language's plural forms) for `count`.
 * Intl.PluralRules came in Chromium 63; before it, the rules of the
 * languages the app has: Portuguese counts 0 and 1 as one, English only 1.
 */
export const pluralForm = (language: Language, count: number): string => {
  if (typeof Intl !== "undefined" && typeof Intl.PluralRules === "function") {
    return new Intl.PluralRules(language).select(count);
  }
  if (base(language) === "pt") return Math.floor(Math.abs(count)) <= 1 ? "one" : "other";
  return count === 1 ? "one" : "other";
};
