import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../data/memoryStorage";
import { createAddons, type AddonList } from "./addons";

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

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const setup = (answers: Record<string, unknown>, lists: AddonList[], storage = memoryStorage()) => {
  const fetch = web(answers);
  const [shown, setShown] = createSignal(lists);
  let time = 1_000_000;
  const addons = createRoot(() =>
    createAddons({ lists: shown, storage, fetch, now: () => time, timeoutMs: 1000 }),
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
    await flush();
    expect(first.addons.states().map(state => state.manifest?.name)).toEqual(["Alpha"]);
    expect(first.addons.catalogs("movie").map(group => group.key)).toEqual(["list-a/movie/top"]);

    const again = setup(answers, [ADDON], first.storage);
    expect(again.addons.catalogs("series").map(group => group.catalog.name)).toEqual(["Shows"]);
    // Read as the add-on sent it, so its search and paging are kept too.
    expect(again.addons.catalogs("movie")[0].catalog).toMatchObject({ search: true, paged: true });
    await flush();
    // Not a day old, so not asked for again.
    expect(again.fetch).not.toHaveBeenCalled();
  });

  it("keep a kept manifest when the add-on can't be reached", async () => {
    const storage = memoryStorage();
    const first = setup({ [ADDON.url]: manifest("Alpha") }, [ADDON], storage);
    await flush();
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
    await flush();
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
    await flush();
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
    await flush();
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
    await flush();
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
    await flush();
    setLists([SECOND]);
    expect(addons.states().map(state => state.manifest?.name)).toEqual(["Beta"]);
    expect(addons.catalogs("movie").map(group => group.addon)).toEqual(["list-b"]);
  });
});
