import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { AddonMeta } from "../stremio/addon";
import { CLEANING } from "../stremio/cinemeta";
import {
  createTitleMatcher,
  KEEP_TMDB_MS,
  matchesOf,
  RETRY_UNMATCHED_MS,
  type KeptMatch,
  type MatchItem,
  type MatchRecord,
  type TitleMatch,
} from "./titleMatches";

const URL_A = "https://cinemeta.example.invalid/manifest.json";

/** A block as written, with its matches read back. */
type Saved = Omit<MatchRecord, "matches"> & { matches: Record<string, KeptMatch> };

const setup = (
  options: {
    kept?: MatchRecord[];
    search?: (title: string) => Promise<AddonMeta[]>;
    now?: () => number;
    byTmdb?: (type: "movie" | "series", tmdb: number) => Promise<TitleMatch | undefined>;
    findMore?: (item: MatchItem, byName: TitleMatch | undefined) => Promise<TitleMatch | undefined | null>;
    findMoreAtOnce?: number;
    blockSize?: number;
    details?: (id: string) => Promise<AddonMeta | undefined>;
    concurrency?: number;
  } = {},
) => {
  const saved: Saved[] = [];
  const details = options.details;
  const trimmed: [string, number][] = [];
  const asked: string[] = [];
  const [items, setItems] = createSignal<MatchItem[]>([]);
  const [on, setOn] = createSignal(true);
  const [url, setUrl] = createSignal(URL_A);
  const search =
    options.search ??
    (async (title: string): Promise<AddonMeta[]> =>
      title === "The Great Adventure"
        ? [{ id: "tt0000001", type: "movie", name: "The Great Adventure", year: 1999, genres: ["Drama"] }]
        : []);
  const matcher = createRoot(() =>
    createTitleMatcher({
      items,
      on,
      cinemetaUrl: url,
      search: async (_type, title) => {
        asked.push(title);
        return search(title);
      },
      details: details && ((_type, id) => details(id)),
      concurrency: options.concurrency,
      byTmdb: options.byTmdb,
      findMore: options.findMore,
      findMoreAtOnce: options.findMoreAtOnce,
      store: {
        load: async () => options.kept ?? [],
        save: async record => void saved.push({ ...record, matches: matchesOf(record) }),
        trim: async (source, from) => void trimmed.push([source, from]),
      },
      now: options.now,
      saveEveryMs: 10,
      publishEveryMs: 5,
      blockSize: options.blockSize,
    }),
  );
  return { matcher, saved, trimmed, asked, setItems, setOn, setUrl };
};

const item = (source: string, id: string, name: string, year?: number): MatchItem => ({
  key: `${source}/${id}`,
  source,
  type: "movie",
  name,
  year,
});

const settle = () => new Promise(resolve => setTimeout(resolve, 40));

const GREAT: AddonMeta[] = [
  { id: "tt0000001", type: "movie", name: "The Great Adventure", year: 1999, genres: ["Drama"] },
];
const RAIN: TitleMatch = {
  id: "tt0000005",
  name: "Rain Over Lisbon",
  year: 2004,
  genres: ["Romance"],
  via: "tmdbSearch",
};
const HARBOUR: TitleMatch = {
  id: "tt0000009",
  name: "Harbour Lights",
  year: 2011,
  genres: ["Crime"],
  via: "tmdb",
};
const searchEndgame = async (title: string): Promise<AddonMeta[]> =>
  title === "Endgame"
    ? [{ id: "tt0000007", type: "movie", name: "Endgame", year: 2019, genres: ["Action"] }]
    : [];

// Cinemeta's search gives no genres or rating.
const bare = async (title: string): Promise<AddonMeta[]> =>
  title === "Alpha Film" || title === "Beta Film"
    ? [{ id: title === "Alpha Film" ? "tt0000011" : "tt0000012", type: "movie", name: title, year: 2001 }]
    : [];
const full = (id: string): AddonMeta => ({
  id,
  type: "movie",
  name: "Details' own name",
  year: 2002,
  genres: ["Comedy"],
  rating: 7.1,
});

describe("createTitleMatcher", () => {
  it("searches once per cleaned name, and keeps each source's matches", async () => {
    const { matcher, saved, asked, setItems } = setup();
    await settle();
    setItems([
      item("a", "m:1", "EN - The Great Adventure (1999)"),
      item("b", "m:2", "The Great Adventure 1999 HD"),
      item("b", "m:3", "Nothing Like It"),
    ]);
    await settle();
    expect(asked).toEqual(["The Great Adventure", "Nothing Like It"]);
    expect(matcher.matchOf({ key: "a/m:1", source: "a" })?.id).toBe("tt0000001");
    expect(matcher.matchOf({ key: "b/m:2", source: "b" })?.genres).toEqual(["Drama"]);
    expect(matcher.matchOf({ key: "b/m:3", source: "b" })).toBeUndefined();
    expect(new Set(saved.map(record => record.source))).toEqual(new Set(["a", "b"]));
    expect(typeof saved.find(record => record.source === "b")?.matches["b/m:3"]).toBe("number");
    expect(matcher.progress()).toMatchObject({ done: 3, total: 3, running: false });
  });

  it("doesn't ask again for what was kept, until an unmatched one is a month old", async () => {
    let time = 1_000_000;
    const kept: MatchRecord[] = [
      {
        source: "a",
        cinemeta: URL_A,
        cleaning: CLEANING,
        matches: {
          "a/m:1": { id: "tt0000001", name: "The Great Adventure", genres: [] },
          "a/m:2": time - 1000,
        },
      },
    ];
    const { asked, setItems } = setup({ kept, now: () => time });
    setItems([item("a", "m:1", "The Great Adventure (1999)"), item("a", "m:2", "Nothing Like It")]);
    await settle();
    expect(asked).toEqual([]);
    time += RETRY_UNMATCHED_MS;
    setItems([item("a", "m:1", "The Great Adventure (1999)"), item("a", "m:2", "Nothing Like It")]);
    await settle();
    expect(asked).toEqual(["Nothing Like It"]);
  });

  it("doesn't take a TMDB id that is another year's title, new or kept", async () => {
    const NOTEBOOK: TitleMatch = {
      id: "tt0000007",
      name: "The Notebook",
      year: 2004,
      genres: [],
      via: "tmdb",
    };
    const kept: MatchRecord[] = [
      { source: "a", cinemeta: URL_A, cleaning: CLEANING, matches: { "a/m:2": NOTEBOOK } },
    ];
    const { matcher, asked, setItems } = setup({ kept, byTmdb: async () => NOTEBOOK });
    setItems([
      { ...item("a", "m:1", "Notebook (2019)"), tmdb: 7 },
      item("a", "m:2", "Notebook (2019)"),
      { ...item("a", "m:3", "The Notebook (2004)"), tmdb: 7 },
    ]);
    await settle();
    // Looked for by name instead; the same name and year is the same search.
    expect(asked).toEqual(["Notebook", "The Notebook"]);
    expect(matcher.matchOf({ key: "a/m:1", source: "a" })).toBeUndefined();
    expect(matcher.matchOf({ key: "a/m:2", source: "a" })).toBeUndefined();
    expect(matcher.matchOf({ key: "a/m:3", source: "a" })?.id).toBe("tt0000007");
  });

  it("looks for a match by TMDB again after six months, as TMDB's terms ask", async () => {
    let time = 1_000_000_000_000;
    const kept: MatchRecord[] = [
      {
        source: "a",
        cinemeta: URL_A,
        cleaning: CLEANING,
        matches: {
          "a/m:1": { id: "tt0000001", name: "The Great Adventure", genres: [] },
          "a/m:2": { id: "tt0000005", name: "Rain Over Lisbon", genres: [], via: "tmdbSearch", at: time },
          "a/m:3": { id: "tt0000009", name: "Harbour", genres: [], via: "tmdb" },
        },
      },
    ];
    const { asked, setItems } = setup({ kept, now: () => time });
    const items = [
      item("a", "m:1", "The Great Adventure (1999)"),
      item("a", "m:2", "Chuva Sobre Lisboa (2004)"),
      item("a", "m:3", "Harbour Lights"),
    ];
    setItems(items);
    await settle();
    expect(asked).toEqual([]);
    time += KEEP_TMDB_MS + 1;
    setItems([...items]);
    await settle();
    // The one kept with no time counts from when it was first seen.
    expect(asked).toEqual(["Chuva Sobre Lisboa", "Harbour Lights", "The Chuva Sobre Lisboa"]);
  });

  it("searches the whole name when the year taken from its end finds nothing", async () => {
    const { matcher, asked, setItems } = setup({
      search: async title =>
        title === "Blade Runner 2049"
          ? [{ id: "tt0000049", type: "movie", name: "Blade Runner 2049", year: 2017 }]
          : [],
    });
    setItems([item("a", "m:1", "Blade Runner 2049")]);
    await settle();
    expect(asked).toEqual(["Blade Runner", "Blade Runner 2049"]);
    expect(matcher.matchOf({ key: "a/m:1", source: "a" })?.id).toBe("tt0000049");
  });

  it("asks another Cinemeta again, and keeps the first one's matches as its own", async () => {
    const { matcher, saved, asked, setItems, setUrl } = setup();
    setItems([item("a", "m:1", "The Great Adventure (1999)")]);
    await settle();
    setUrl("https://other.example.invalid/manifest.json");
    await settle();
    expect(asked).toEqual(["The Great Adventure", "The Great Adventure"]);
    expect(saved.map(record => record.cinemeta)).toEqual([
      URL_A,
      "https://other.example.invalid/manifest.json",
    ]);
    expect(matcher.matchOf({ key: "a/m:1", source: "a" })?.id).toBe("tt0000001");
  });

  it("looks again for titles an older cleaning didn't find", async () => {
    const time = 1_000_000;
    const kept: MatchRecord[] = [
      {
        source: "a",
        cinemeta: URL_A,
        matches: {
          "a/m:1": time - 1000,
          "a/m:2": { id: "tt0000001", name: "The Great Adventure", genres: [] },
        },
      },
    ];
    const { asked, saved, setItems } = setup({ kept, now: () => time });
    setItems([item("a", "m:1", "Nothing-Like-It-1 (2001)"), item("a", "m:2", "The Great Adventure (1999)")]);
    await settle();
    expect(asked.slice(0, 2)).toEqual(["Nothing Like It 1", "Nothing Like It"]);
    expect(saved[saved.length - 1]?.cleaning).toBeGreaterThan(1);
  });

  it("checks again a match an older cleaning guessed under another name", async () => {
    const kept: MatchRecord[] = [
      {
        source: "a",
        cinemeta: URL_A,
        cleaning: 2,
        matches: {
          "a/m:1": { id: "tt0000009", name: "Endgame", genres: [] },
          "a/m:2": { id: "tt0000001", name: "The Great Adventure", genres: [] },
        },
      },
    ];
    const { matcher, asked, setItems } = setup({ kept });
    setItems([item("a", "m:1", "Avengers-4-Endgame (2019)"), item("a", "m:2", "The Great Adventure (1999)")]);
    await settle();
    expect(asked[0]).toBe("Avengers 4 Endgame");
    expect(asked).not.toContain("The Great Adventure");
    expect(matcher.matchOf({ key: "a/m:1", source: "a" })).toBeUndefined();
  });

  it("matches a title by its TMDB id first, asking for them all at once, without searching", async () => {
    const asksAtOnce: number[][] = [];
    let waiting: number[] = [];
    const { matcher, asked, setItems } = setup({
      byTmdb: async (_type, tmdb) => {
        waiting.push(tmdb);
        await Promise.resolve();
        if (waiting.length) asksAtOnce.push(waiting);
        waiting = [];
        return tmdb === 90 ? HARBOUR : undefined;
      },
    });
    await settle();
    setItems([
      { ...item("a", "s:1", "PT - Luzes do Porto"), type: "series", tmdb: 90 },
      { ...item("a", "s:2", "The Great Adventure"), type: "series", tmdb: 91 },
      { ...item("a", "s:3", "Nothing Like It"), type: "series", tmdb: 92 },
      { ...item("a", "s:4", "Nothing Else"), type: "series", tmdb: 93 },
      { ...item("a", "s:5", "Nothing More"), type: "series", tmdb: 94 },
    ]);
    await settle();
    expect(asksAtOnce[0]).toEqual([90, 91, 92, 93, 94]);
    expect(matcher.matchOf({ key: "a/s:1", source: "a" })).toMatchObject({ id: "tt0000009", via: "tmdb" });
    // Not found by its TMDB id, so its name is searched.
    expect(asked).not.toContain("Luzes do Porto");
    expect(asked).toContain("The Great Adventure");
    expect(matcher.matchOf({ key: "a/s:2", source: "a" })?.via).toBe("name");
  });

  it("looks another way for a title its name didn't find, or found by a guess, a few at a time", async () => {
    const more: string[] = [];
    let atOnce = 0;
    let mostAtOnce = 0;
    const { matcher, saved, setItems } = setup({
      search: async title =>
        (await searchEndgame(title)).concat(title === "The Great Adventure" ? GREAT : []),
      findMoreAtOnce: 2,
      findMore: async (one, byName) => {
        more.push(one.key);
        mostAtOnce = Math.max(mostAtOnce, ++atOnce);
        await new Promise(resolve => setTimeout(resolve, 3));
        atOnce--;
        if (one.key === "a/m:2" || one.key === "a/m:5") return RAIN;
        return byName;
      },
    });
    await settle();
    setItems([
      item("a", "m:1", "The Great Adventure (1999)"),
      item("a", "m:2", "Chuva Sobre Lisboa (2004)"),
      item("a", "m:3", "Nothing Like It"),
      item("a", "m:4", "Avengers: Endgame (2019)"),
      item("a", "m:5", "Other: Endgame (2019)"),
    ]);
    await new Promise(resolve => setTimeout(resolve, 80));
    // Not the one found by its name.
    expect(new Set(more)).toEqual(new Set(["a/m:2", "a/m:3", "a/m:4", "a/m:5"]));
    expect(mostAtOnce).toBe(2);
    expect(matcher.matchOf({ key: "a/m:2", source: "a" })).toMatchObject({
      id: "tt0000005",
      via: "tmdbSearch",
    });
    expect(typeof saved[saved.length - 1]?.matches["a/m:3"]).toBe("number");
    // A guess is kept when nothing else is found, and put right when something is.
    expect(matcher.matchOf({ key: "a/m:4", source: "a" })).toMatchObject({ id: "tt0000007", via: "guess" });
    expect(matcher.matchOf({ key: "a/m:5", source: "a" })?.id).toBe("tt0000005");
    expect(matcher.progress()).toMatchObject({ running: false, waitingMore: 0, askedMore: 4 });
  });

  it("keeps looking another way when the titles change, each title once", async () => {
    const more: string[] = [];
    const { matcher, setItems } = setup({
      findMore: async one => {
        more.push(one.key);
        await new Promise(resolve => setTimeout(resolve, 15));
        return RAIN;
      },
    });
    await settle();
    const films = ["m:1", "m:2", "m:3"].map(id => item("a", id, `Nothing ${id}`));
    setItems(films);
    await new Promise(resolve => setTimeout(resolve, 5));
    // A new round, as when a source is imported again.
    setItems([...films]);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(more).toHaveLength(3);
    expect(new Set(more).size).toBe(3);
    for (const film of films) expect(matcher.matchOf(film)?.via).toBe("tmdbSearch");
    expect(matcher.progress()).toMatchObject({ running: false, waitingMore: 0 });
  });

  it("looks again next time for a title that couldn't be looked for another way", async () => {
    const { matcher, saved, setItems } = setup({ findMore: async () => null });
    await settle();
    setItems([item("a", "m:1", "Nothing Like It")]);
    await settle();
    expect(matcher.matchOf({ key: "a/m:1", source: "a" })).toBeUndefined();
    expect(saved.some(record => "a/m:1" in record.matches)).toBe(false);
    expect(matcher.progress().running).toBe(false);
  });

  it("doesn't check again a TMDB match an older cleaning found", async () => {
    const kept: MatchRecord[] = [
      { source: "a", cinemeta: URL_A, cleaning: CLEANING - 1, matches: { "a/m:1": RAIN } },
    ];
    const { asked, setItems } = setup({ kept });
    await settle();
    setItems([item("a", "m:1", "Chuva Sobre Lisboa (2004)")]);
    await settle();
    expect(asked).toEqual([]);
  });

  it("stops while off, and waits when Cinemeta can't be reached", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { matcher, asked, setItems, setOn } = setup({ search: () => Promise.reject(new Error("offline")) });
    setOn(false);
    setItems([item("a", "m:1", "Something")]);
    await settle();
    expect(asked).toEqual([]);
    setOn(true);
    await settle();
    expect(asked).toEqual(["Something"]);
    expect(matcher.matchOf({ key: "a/m:1", source: "a" })).toBeUndefined();
    vi.restoreAllMocks();
  });
  it("keeps matches in blocks, as text, and writes only the blocks that changed", async () => {
    const { matcher, saved, trimmed, setItems } = setup({ blockSize: 2 });
    await settle();
    setItems([
      item("a", "m:1", "The Great Adventure (1999)"),
      item("a", "m:2", "Nothing Like It"),
      item("a", "m:3", "Something Else"),
    ]);
    await settle();
    const last = new Map(saved.map(record => [record.block, record]));
    expect(new Set(last.keys())).toEqual(new Set([0, 1]));
    expect(Object.keys(last.get(0)?.matches ?? {})).toEqual(["a/m:1", "a/m:2"]);
    expect(Object.keys(last.get(1)?.matches ?? {})).toEqual(["a/m:3"]);
    expect(trimmed).toEqual([]);

    // A title in the second block found again: that block only is written.
    saved.length = 0;
    setItems([item("a", "m:4", "The Great Adventure 1999")]);
    await settle();
    expect(saved.map(record => record.block)).toEqual([1]);
    expect(Object.keys(saved[0].matches)).toEqual(["a/m:3", "a/m:4"]);
    expect(matcher.matchOf({ key: "a/m:4", source: "a" })?.id).toBe("tt0000001");
  });

  it("reads its blocks back, and writes a record from before as blocks, then deletes it", async () => {
    const great = { id: "tt0000001", name: "The Great Adventure", genres: ["Drama"] };
    const kept: MatchRecord[] = [
      {
        source: "a",
        block: 0,
        cinemeta: URL_A,
        cleaning: CLEANING,
        matches: JSON.stringify({ "a/m:1": great }),
      },
      {
        source: "b",
        cinemeta: URL_A,
        cleaning: CLEANING,
        matches: { "b/m:1": great, "b/m:2": 1, "b/m:3": great },
      },
      // Written again from b's record, cut short: b's record has it all.
      { source: "b", block: 0, cinemeta: URL_A, cleaning: CLEANING, matches: "{}" },
    ];
    const { matcher, saved, trimmed, asked } = setup({ kept, blockSize: 2 });
    await settle();
    expect(asked).toEqual([]);
    expect(matcher.matchOf({ key: "a/m:1", source: "a" })?.id).toBe("tt0000001");
    expect(matcher.matchOf({ key: "b/m:3", source: "b" })?.id).toBe("tt0000001");
    expect(saved.map(record => [record.source, record.block, Object.keys(record.matches)])).toEqual([
      ["b", 0, ["b/m:1", "b/m:2"]],
      ["b", 1, ["b/m:3"]],
    ]);
    expect(trimmed).toEqual([["b", 2]]);
  });

  it("writes over another Cinemeta's blocks, all at once", async () => {
    const kept: MatchRecord[] = [
      { source: "a", block: 0, cinemeta: "https://old.example.invalid/manifest.json", matches: "{}" },
      { source: "a", block: 1, cinemeta: "https://old.example.invalid/manifest.json", matches: "{}" },
    ];
    const { saved, trimmed, setItems } = setup({ kept });
    await settle();
    expect(saved).toEqual([]);
    setItems([item("a", "m:1", "The Great Adventure (1999)")]);
    await settle();
    expect(saved.map(record => [record.block, record.cinemeta])).toEqual([[0, URL_A]]);
    expect(trimmed).toEqual([["a", 1]]);
  });

  describe("Cinemeta's details, after the searches", () => {
    it("asks for them once every search is done, and fills in each match", async () => {
      const calls: string[] = [];
      const { matcher, saved, setItems } = setup({
        concurrency: 1,
        search: async title => {
          calls.push(`search ${title}`);
          return bare(title);
        },
        details: async id => {
          calls.push(`details ${id}`);
          return full(id);
        },
      });
      await settle();
      setItems([item("a", "m:1", "Alpha Film"), item("a", "m:2", "Beta Film"), item("a", "m:3", "Gamma")]);
      await settle();
      expect(calls).toEqual([
        "search Alpha Film",
        "search Beta Film",
        "search Gamma",
        "details tt0000011",
        "details tt0000012",
      ]);
      const match = matcher.matchOf({ key: "a/m:1", source: "a" });
      expect(match).toMatchObject({ name: "Alpha Film", year: 2002, genres: ["Comedy"], rating: 7.1 });
      expect(match?.partial).toBeUndefined();
      const mine = saved.filter(record => record.source === "a");
      const last = mine[mine.length - 1];
      expect(last?.matches["a/m:2"]).not.toHaveProperty("partial");
      expect(matcher.progress()).toMatchObject({ running: false, waitingDetails: 0 });
    });

    it("asks once for a match titles share, and fills in each", async () => {
      const details = vi.fn<(id: string) => Promise<AddonMeta>>(async id => full(id));
      const { matcher, setItems } = setup({ search: bare, details });
      await settle();
      setItems([item("a", "m:1", "Alpha Film (2001)"), item("b", "m:1", "EN - Alpha Film")]);
      await settle();
      expect(details).toHaveBeenCalledTimes(1);
      expect(matcher.matchOf({ key: "a/m:1", source: "a" })?.genres).toEqual(["Comedy"]);
      expect(matcher.matchOf({ key: "b/m:1", source: "b" })?.genres).toEqual(["Comedy"]);
    });

    it("asks only for the details of a partial match kept, without searching", async () => {
      const kept: MatchRecord = {
        source: "a",
        block: 0,
        cinemeta: URL_A,
        cleaning: CLEANING,
        matches: JSON.stringify({
          "a/m:1": { id: "tt0000011", name: "Alpha Film", genres: [], via: "name", partial: true },
        }),
      };
      const details = vi.fn<(id: string) => Promise<AddonMeta>>(async id => full(id));
      const { matcher, asked, setItems } = setup({ kept: [kept], search: bare, details });
      await settle();
      setItems([item("a", "m:1", "Alpha Film")]);
      await settle();
      expect(asked).toEqual([]);
      expect(details).toHaveBeenCalledWith("tt0000011");
      expect(matcher.matchOf({ key: "a/m:1", source: "a" })).toMatchObject({ genres: ["Comedy"] });
    });

    it("keeps a match partial when there are no details, to ask again next time", async () => {
      const { matcher, setItems } = setup({ search: bare, details: async () => undefined });
      await settle();
      setItems([item("a", "m:1", "Alpha Film")]);
      await settle();
      expect(matcher.matchOf({ key: "a/m:1", source: "a" })).toMatchObject({
        name: "Alpha Film",
        partial: true,
      });
      expect(matcher.progress().running).toBe(false);
    });
  });
});
