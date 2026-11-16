import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../data/memoryStorage";
import { createAddons, type AddonList, type Addons, type AddonsOptions, STREAMS_KEPT_MS } from "./addons";
import { SNAPSHOT_MS, type SnapshotPage, type SnapshotRecord } from "./catalogSnapshot";

const BASE = "https://addon.example.invalid";
const OTHER = "https://other.example.invalid";

const manifest = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `test.${name}`,
  name,
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  resources: ["catalog", "meta", "stream", "subtitles"],
  catalogs: [
    { type: "movie", id: "top", name: "Top", extra: [{ name: "skip" }, { name: "search" }] },
    { type: "series", id: "shows", name: "Shows" },
  ],
  ...extra,
});

const film = (n: number) => ({ id: `tt${n}`, type: "movie", name: `Film ${n}` });

/** A fake web of add-ons: each address answers a JSON value, or an error status. */
const urlOf = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const web = (answers: Record<string, unknown>) =>
  vi.fn<typeof fetch>(input => {
    const url = urlOf(input);
    if (!(url in answers)) return Promise.resolve(new Response("{}", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(answers[url])));
  });

const flush = (addons: Addons) => vi.waitUntil(() => addons.states().every(state => !state.loading));

const setup = (
  answers: Record<string, unknown>,
  lists: AddonList[],
  storage = memoryStorage(),
  extra: Partial<AddonsOptions> = {},
) => {
  const fetch = web(answers);
  const [shown, setShown] = createSignal(lists);
  let time = 1_000_000;
  const addons = createRoot(() =>
    createAddons({ lists: shown, storage, fetch, now: () => time, timeoutMs: 1000, ...extra }),
  );
  return {
    addons,
    fetch,
    storage,
    setLists: setShown,
    later: (ms: number) => (time += ms),
  };
};

const ADDON: AddonList = { id: "list-a", name: "A", url: `${BASE}/manifest.json` };
const SECOND: AddonList = { id: "list-b", name: "B", url: `${OTHER}/manifest.json` };

describe("the add-ons", () => {
  it("read each manifest, keep it, and use the kept one at the next start", async () => {
    const answers = { [ADDON.url]: manifest("Alpha") };
    const first = setup(answers, [ADDON]);
    await flush(first.addons);
    expect(first.addons.states().map(state => state.manifest?.name)).toEqual(["Alpha"]);
    expect(first.addons.catalogs("movie").map(group => group.key)).toEqual(["list-a/movie/top"]);

    const again = setup(answers, [ADDON], first.storage);
    expect(again.addons.catalogs("series").map(group => group.catalog.name)).toEqual(["Shows"]);
    // Read as the add-on sent it, so its search and paging are kept too.
    expect(again.addons.catalogs("movie")[0].catalog).toMatchObject({ search: true, paged: true });
    await flush(again.addons);
    // Not a day old, so not asked for again.
    expect(again.fetch).not.toHaveBeenCalled();
  });

  it("keep a kept manifest when the add-on can't be reached", async () => {
    const storage = memoryStorage();
    const first = setup({ [ADDON.url]: manifest("Alpha") }, [ADDON], storage);
    await flush(first.addons);
    first.later(0);
    const offline = setup({}, [ADDON], storage);
    offline.later(25 * 3_600_000);
    await offline.addons.refresh();
    expect(offline.addons.states()[0]).toMatchObject({
      manifest: { name: "Alpha" },
      problem: "The add-on answered 404",
    });
  });

  it("load a catalog page by page until one adds nothing", async () => {
    const { addons } = setup(
      {
        [ADDON.url]: manifest("Alpha"),
        [`${BASE}/catalog/movie/top.json`]: { metas: [film(1), film(2)] },
        [`${BASE}/catalog/movie/top/skip=2.json`]: { metas: [film(2), film(3)] },
        [`${BASE}/catalog/movie/top/skip=3.json`]: { metas: [] },
      },
      [ADDON],
    );
    await flush(addons);
    const [group] = addons.catalogs("movie");
    await addons.loadPage(group);
    await addons.loadPage(group);
    expect(addons.pages()[group.key]).toMatchObject({ done: false, loading: false });
    await addons.loadPage(group);
    expect(addons.pages()[group.key].items.map(item => item.id)).toEqual(["tt1", "tt2", "tt3"]);
    expect(addons.pages()[group.key].done).toBe(true);
  });

  it("ask the catalog's own add-on for details first, then the others", async () => {
    const { addons, fetch } = setup(
      {
        [ADDON.url]: manifest("Alpha"),
        [SECOND.url]: manifest("Beta"),
        [`${OTHER}/meta/movie/tt1.json`]: { meta: { ...film(1), description: "From Beta" } },
      },
      [ADDON, SECOND],
    );
    await flush(addons);
    expect((await addons.meta("movie", "tt1", "list-b"))?.plot).toBe("From Beta");
    // Beta first, so Alpha wasn't asked.
    expect(fetch.mock.calls.map(call => urlOf(call[0]))).not.toContain(`${BASE}/meta/movie/tt1.json`);
    expect((await addons.meta("movie", "tt1"))?.plot).toBe("From Beta");
  });

  it("gather every add-on's streams and subtitles, saying which failed", async () => {
    const { addons } = setup(
      {
        [ADDON.url]: manifest("Alpha"),
        [SECOND.url]: manifest("Beta", { resources: ["stream"] }),
        [`${BASE}/stream/movie/tt1.json`]: {
          streams: [{ url: `${BASE}/film.mp4`, name: "Alpha HD" }, { infoHash: "ab" }],
        },
        [`${BASE}/subtitles/movie/tt1.json`]: { subtitles: [{ id: "s", url: `${BASE}/s.srt`, lang: "eng" }] },
      },
      [ADDON, SECOND],
    );
    await flush(addons);
    const found = await addons.streams("movie", "tt1");
    expect(found.map(one => [one.addonName, one.streams.length, one.unplayable, one.problem])).toEqual([
      ["Alpha", 1, 1, undefined],
      ["Beta", 0, 0, "The add-on answered 404"],
    ]);
    expect(await addons.subtitles("movie", "tt1")).toEqual([
      { id: "s", url: `${BASE}/s.srt`, language: "eng", addonName: "Alpha" },
    ]);
  });

  it("search the catalogs that can, each title once", async () => {
    const { addons } = setup(
      {
        [ADDON.url]: manifest("Alpha"),
        [`${BASE}/catalog/movie/top/search=test.json`]: { metas: [film(1), film(1), film(4)] },
      },
      [ADDON],
    );
    await flush(addons);
    expect((await addons.search("movie", "test")).map(meta => [meta.id, meta.addon])).toEqual([
      ["tt1", "list-a"],
      ["tt4", "list-a"],
    ]);
    expect(await addons.search("series", "test")).toEqual([]);
  });

  it("drop an add-on the profile no longer has", async () => {
    const { addons, setLists } = setup({ [ADDON.url]: manifest("Alpha"), [SECOND.url]: manifest("Beta") }, [
      ADDON,
      SECOND,
    ]);
    await flush(addons);
    setLists([SECOND]);
    expect(addons.states().map(state => state.manifest?.name)).toEqual(["Beta"]);
    expect(addons.catalogs("movie").map(group => group.addon)).toEqual(["list-b"]);
  });

  it("keep a title's streams for 15 minutes", async () => {
    const answers = {
      [ADDON.url]: manifest("Alpha"),
      [`${BASE}/stream/movie/tt1.json`]: { streams: [{ url: `${BASE}/film.mp4`, name: "Alpha" }] },
    };
    const { addons, fetch, later } = setup(answers, [ADDON]);
    await flush(addons);
    const asked = () => fetch.mock.calls.filter(call => urlOf(call[0]).includes("/stream/")).length;
    await addons.streams("movie", "tt1");
    later(STREAMS_KEPT_MS - 1);
    await addons.streams("movie", "tt1");
    expect(asked()).toBe(1);
    later(2);
    await addons.streams("movie", "tt1");
    expect(asked()).toBe(2);
  });

  it("tell each add-on's streams as it answers, in the account's order", async () => {
    const answers: Record<string, unknown> = {
      [ADDON.url]: manifest("Alpha", { resources: ["stream"] }),
      [SECOND.url]: manifest("Beta", { resources: ["stream"] }),
    };
    const { addons, fetch } = setup(answers, [ADDON, SECOND]);
    await flush(addons);
    const later: Record<string, (value: unknown) => void> = {};
    fetch.mockImplementation(input => {
      const url = urlOf(input);
      return new Promise(resolve => {
        later[url] = value => resolve(new Response(JSON.stringify(value)));
      });
    });
    const told: { found: string[]; waiting: string[]; done: boolean }[] = [];
    addons.watchStreams("movie", "tt1", search =>
      told.push({ found: search.found.map(one => one.addon), waiting: search.waiting, done: search.done }),
    );
    await vi.waitUntil(() => Object.keys(later).length === 2);
    later[`${OTHER}/stream/movie/tt1.json`]({ streams: [{ url: `${OTHER}/b.mp4` }] });
    await vi.waitUntil(() => told.length === 2);
    later[`${BASE}/stream/movie/tt1.json`]({ streams: [{ url: `${BASE}/a.mp4` }] });
    await vi.waitUntil(() => told.some(one => one.done));
    expect(told[0]).toEqual({ found: [], waiting: ["list-a", "list-b"], done: false });
    expect(told[1]).toEqual({ found: ["list-b"], waiting: ["list-a"], done: false });
    expect(told[told.length - 1]).toEqual({ found: ["list-a", "list-b"], waiting: [], done: true });
  });

  it("show a catalog's kept first page at once, and keep the pages it asks for", async () => {
    const kept: Record<string, SnapshotRecord> = {};
    const snapshots = {
      read: vi.fn<(type: string) => Promise<SnapshotPage[]>>(async type => kept[type]?.pages ?? []),
      write: vi.fn<(record: SnapshotRecord) => Promise<void>>(async record => {
        kept[record.type] = record;
      }),
    };
    const answers = {
      [ADDON.url]: manifest("Alpha"),
      [`${BASE}/catalog/movie/top.json`]: { metas: [film(1), film(2)] },
    };
    const first = setup(answers, [ADDON], memoryStorage(), { snapshots });
    await flush(first.addons);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const [group] = first.addons.catalogs("movie");
      await first.addons.loadPage(group);
      expect(snapshots.write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
    } finally {
      vi.useRealTimers();
    }
    expect(kept.movie.pages.map(page => [page.key, page.items.length])).toEqual([["list-a/movie/top", 2]]);
    expect(JSON.stringify(kept.movie).length).toBeGreaterThan(64 * 1024);

    const second = setup(answers, [ADDON], first.storage, { snapshots });
    await flush(second.addons);
    const [group] = second.addons.catalogs("movie");
    await second.addons.loadPage(group);
    expect(second.addons.pages()[group.key].items.map(item => item.id)).toEqual(["tt1", "tt2"]);
    expect(second.fetch.mock.calls.map(call => urlOf(call[0]))).not.toContain(
      `${BASE}/catalog/movie/top.json`,
    );

    // Twelve hours on, it's asked for again.
    const third = setup(answers, [ADDON], first.storage, { snapshots });
    third.later(SNAPSHOT_MS);
    await flush(third.addons);
    await third.addons.loadPage(third.addons.catalogs("movie")[0]);
    expect(third.fetch.mock.calls.map(call => urlOf(call[0]))).toContain(`${BASE}/catalog/movie/top.json`);
  });
});
