import { describe, expect, it } from "vitest";
import { languageKey, languageName, sameLanguage } from "./language";

describe("track languages", () => {
  it("treats two- and three-letter codes as one language", () => {
    expect(languageKey("deu")).toBe("de");
    expect(languageKey("GER")).toBe("de");
    expect(languageKey("de-DE")).toBe("de");
    expect(languageKey("en_GB")).toBe("en");
    expect(languageKey("tlh")).toBe("tlh");
    expect(sameLanguage("eng", "en")).toBe(true);
    expect(sameLanguage("fre", "fra")).toBe(true);
    expect(sameLanguage("de", "en")).toBe(false);
    expect(sameLanguage(undefined, undefined)).toBe(false);
    expect(sameLanguage("", "")).toBe(false);
  });

  it("names a language, or shows its code", () => {
    expect(languageName("deu")).toBe("German");
    expect(languageName(undefined)).toBeUndefined();
    expect(languageName("qqq")).toBe("QQQ");
  });
});
