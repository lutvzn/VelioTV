import { describe, expect, it } from "vitest";
import type { AddonMeta } from "./addon";
import { cleanTitle, isImdbId, nameKey, pickMatch, tagLanguage } from "./cinemeta";

const meta = (id: string, name: string, year?: number): AddonMeta => ({ id, type: "movie", name, year });

const others = (name: string) => cleanTitle(name).others.map(one => one.title);

describe("cleanTitle", () => {
  it("takes the year from brackets or the end", () => {
    expect(cleanTitle("The Great Adventure (1999)")).toMatchObject({
      title: "The Great Adventure",
      year: 1999,
    });
    expect(cleanTitle("The Great Adventure 1999")).toMatchObject({
      title: "The Great Adventure",
      year: 1999,
    });
    expect(cleanTitle("The.Great.Adventure.1999.1080p")).toMatchObject({
      title: "The Great Adventure",
      year: 1999,
    });
  });

  it("drops the providers' tags and quality words", () => {
    expect(cleanTitle("EN - The Great Adventure [4K] (1999)").title).toBe("The Great Adventure");
    expect(cleanTitle("|PT| A Grande Aventura HD").title).toBe("A Grande Aventura");
    expect(cleanTitle("[MULTI] Night Train FHD").title).toBe("Night Train");
  });

  it("drops hyphen tags, and the name again in another script", () => {
    expect(cleanTitle("KU-B--Pirates-of-the-Caribbean--At-World-s-End (2007)")).toMatchObject({
      title: "Pirates of the Caribbean: At World's End",
      year: 2007,
    });
    expect(cleanTitle("KU--Ballerina (2016)").title).toBe("Ballerina");
    expect(cleanTitle("KRD-S--Hotarubi-no-Mori-e (2011)").title).toBe("Hotarubi no Mori e");
    expect(cleanTitle("Furiosa A Mad Max Saga 2024 فوریوسا چیروکا ماکسێ دین")).toMatchObject({
      title: "Furiosa A Mad Max Saga",
      year: 2024,
    });
    expect(cleanTitle("Death of Rawls کوشتنگەها رولز").title).toBe("Death of Rawls");
    // A name only in another script is kept.
    expect(cleanTitle("الدور السابع (2026)").title).toBe("الدور السابع");
  });

  it("reads a tag's language", () => {
    expect(tagLanguage("ES - Vaiana 2 (2024)")).toBe("es");
    expect(tagLanguage("TR: Zoomania - Hayvanlar Sehri")).toBe("tr");
    expect(tagLanguage("|DE| Filme")).toBe("de");
    expect(tagLanguage("KU-B--Dil-Hai-Tumhaara (2002)")).toBe("ku");
    expect(tagLanguage("The Great Adventure")).toBeUndefined();
    expect(tagLanguage("ZZ: Something")).toBeUndefined();
    expect(tagLanguage(undefined)).toBeUndefined();
  });

  it("keeps the whole name when its last word may be the title's", () => {
    expect(cleanTitle("Blade Runner 2049")).toEqual({
      title: "Blade Runner",
      year: 2049,
      others: [{ title: "Blade Runner 2049" }, { title: "The Blade Runner", year: 2049 }],
    });
    expect(cleanTitle("Blade Runner 2049 (2017)")).toEqual({
      title: "Blade Runner 2049",
      year: 2017,
      others: [{ title: "The Blade Runner 2049", year: 2017 }],
    });
  });

  it("reads hyphens as spaces in a name written with no spaces", () => {
    expect(cleanTitle("13-Hours--The-Secret-Soldiers-Of-Benghazi (2016)").title).toBe(
      "13 Hours: The Secret Soldiers Of Benghazi",
    );
    expect(cleanTitle("Angels---Demons (2009)").title).toBe("Angels & Demons");
    expect(cleanTitle("Spider-Man and Friends (2002)").title).toBe("Spider-Man and Friends");
  });

  it("gives the names a provider's franchise naming may hide", () => {
    expect(others("A-Quiet-Place-1 (2018)")).toEqual(["A Quiet Place"]);
    expect(others("Bāhubali 2 The Conclusion")).toEqual([]);
    expect(others("Avengers-2-Age-Of-Ultron (2015)")).toContain("Avengers Age Of Ultron");
    expect(others("Avengers-1 (2012)")).toContain("The Avengers");
    expect(others("Bad-Boys-2 (2003)")).toContain("Bad Boys II");
    expect(others("Back-To-The-Future-2 (1989)")).toContain("Back To The Future Part II");
    expect(cleanTitle("Bram-Stoker-s-Dracula (1992)").title).toBe("Bram Stoker's Dracula");
    expect(others("Ant-Man-3-Ant-Man-And-The-Wasp-Quantumania (2023)")).toContain(
      "Ant Man And The Wasp Quantumania",
    );
    expect(others("Batman--The-Dark-Knight (2008)")).toContain("The Dark Knight");
    expect(cleanTitle("Avengers-2-Age-Of-Ultron (2015)").others[0].year).toBe(2015);
    expect(others("The Great Adventure (1999)")).toEqual([]);
  });

  it("keeps a year given, and a name that is only a number", () => {
    expect(cleanTitle("Night Train", 2004)).toMatchObject({ title: "Night Train", year: 2004 });
    expect(cleanTitle("1917").title).toBe("1917");
  });
});

describe("pickMatch", () => {
  const found = [
    meta("tt1", "The Great Adventure", 1960),
    meta("tt2", "The Great Adventure", 1999),
    meta("tt3", "Great Adventures", 1999),
  ];

  it("picks the same name with the nearest year", () => {
    expect(pickMatch(found, "the great adventure", 2000)?.id).toBe("tt2");
    expect(pickMatch(found, "The Great Adventure")?.id).toBe("tt1");
  });

  it("takes no result without a year for a name guessed at", () => {
    expect(pickMatch([meta("tt9", "Endgame")], "Endgame", 2019, true)).toBeUndefined();
    expect(pickMatch([meta("tt9", "Endgame", 2019)], "Endgame", 2019, true)?.id).toBe("tt9");
    expect(pickMatch([meta("tt9", "Endgame")], "Endgame", undefined, true)).toBeUndefined();
  });

  it("joins nothing on a guess", () => {
    expect(pickMatch(found, "The Great Adventure", 1980)).toBeUndefined();
    expect(pickMatch(found, "Great Adventure", 1999)).toBeUndefined();
  });

  it("compares names folded", () => {
    expect(nameKey("Café & Crème")).toBe(nameKey("cafe and creme"));
    expect(isImdbId("tt0010001")).toBe(true);
    expect(isImdbId("vtf1")).toBe(false);
  });
});
