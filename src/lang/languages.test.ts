import { afterEach, describe, expect, it } from "vitest";
import en from "./en.json";
import { LANGUAGES, matchLanguage, pluralForm } from "./languages";
import ptBR from "./pt-BR.json";

describe("picking the language", () => {
  it("takes the TV's language, then one of the same language, then English", () => {
    expect(matchLanguage(["pt-BR"])).toBe("pt-BR");
    expect(matchLanguage(["pt_br"])).toBe("pt-BR");
    expect(matchLanguage(["pt-PT", "en-GB"])).toBe("pt-BR");
    expect(matchLanguage(["en-US", "pt-BR"])).toBe("en");
    expect(matchLanguage(["de-DE", "pt-BR"])).toBe("pt-BR");
    expect(matchLanguage(["de-DE"])).toBe("en");
    expect(matchLanguage(["fr", "pt"])).toBe("pt-BR");
    expect(matchLanguage([])).toBe("en");
  });
});

const forms = () => ({
  en: [0, 1, 2].map(n => pluralForm("en", n)),
  pt: [0, 1, 2].map(n => pluralForm("pt-BR", n)),
});

describe("plural forms", () => {
  const rules = Intl.PluralRules;
  afterEach(() => {
    Object.assign(Intl, { PluralRules: rules });
  });

  it("follow each language's rules, with Intl.PluralRules or without it", () => {
    const expected = { en: ["other", "one", "other"], pt: ["one", "one", "other"] };
    expect(forms()).toEqual(expected);
    // Chromium before 63.
    Object.assign(Intl, { PluralRules: undefined });
    expect(forms()).toEqual(expected);
  });
});

const placeholders = (text: string) =>
  new Set((text.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map(found => found.replace(/[{}\s]/g, "")));

describe("the translations", () => {
  const dictionaries: Record<string, Record<string, string>> = { "pt-BR": ptBR };

  it("cover every English string, with the same values in them", () => {
    expect(new Set(Object.keys(dictionaries))).toEqual(
      new Set(LANGUAGES.filter(language => language !== "en")),
    );
    for (const [language, dictionary] of Object.entries(dictionaries)) {
      const englishKeys = Object.keys(en);
      expect({ language, missing: englishKeys.filter(key => !(key in dictionary)) }).toEqual({
        language,
        missing: [],
      });
      expect({ language, extra: Object.keys(dictionary).filter(key => !(key in en)) }).toEqual({
        language,
        extra: [],
      });
      for (const [key, english] of Object.entries(en)) {
        expect({ key, values: placeholders(dictionary[key] ?? "") }).toEqual({
          key,
          values: placeholders(english),
        });
      }
    }
  });
});
