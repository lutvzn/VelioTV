// The app's text in the language picked (PLAN.md, Phase 8, step 5). English
// is built in; another language loads with the app's scripts (import()), as
// a fetch of a file inside the TV package can fail. A string a language
// doesn't have shows in English.
//
// Strings can hold {{ name }} for values passed in. A string with plural
// forms has one key per form, "key.one" and "key.other" (and "key.few" and
// so on where a language has them): $tn() picks the form for a count.

import * as i18n from "@solid-primitives/i18n";
import { createMemo, createResource, createRoot, createSignal } from "solid-js";
import en from "./lang/en.json";
import { type Language, pluralForm } from "./lang/languages";

export type Dictionary = typeof en;
export type TextKey = keyof Dictionary;
/** Keys with plural forms, without the form: "count.channels" for "count.channels.other". */
export type PluralKey = { [K in TextKey]: K extends `${infer Base}.other` ? Base : never }[TextKey];

const loaders: Record<Exclude<Language, "en">, () => Promise<Partial<Dictionary>>> = {
  "pt-BR": () => import("./lang/pt-BR.json").then(module => module.default),
};

const load = async (language: Language): Promise<Partial<Dictionary>> => {
  if (language === "en") return {};
  try {
    return await loaders[language]();
  } catch (error) {
    console.error(`Couldn't load the ${language} text:`, error);
    return {};
  }
};

export const isTextKey = (key: string): key is TextKey => key in en;

const { language, setLanguage, dictionary } = createRoot(() => {
  const [wanted, setWanted] = createSignal<Language>("en");
  const [loaded] = createResource(wanted, load, { initialValue: {} });
  const merged = createMemo(() => ({ ...en, ...loaded.latest }));
  // The language shown changes once its text is here.
  const shown = createMemo<Language>(before => (loaded.loading ? before : wanted()), "en");
  return { language: shown, setLanguage: setWanted, dictionary: merged };
});

const $t = i18n.translator(dictionary, i18n.resolveTemplate);

/** A count in the language's digits, such as 9.698 in Portuguese. */
const formatCount = (count: number) => count.toLocaleString(language());

/** The plural form of `key` for `count`, which it gets as {{ count }}, written out. */
const $tn = (key: PluralKey, count: number, values: Record<string, string | number> = {}) => {
  const form = `${key}.${pluralForm(language(), count)}`;
  const chosen = isTextKey(form) ? form : (`${key}.other` as const);
  return $t(chosen, { ...values, count: formatCount(count) });
};

/** The language's tag, for dates and numbers. */
const locale = language;

export { $t, $tn, formatCount, language, locale, setLanguage };
