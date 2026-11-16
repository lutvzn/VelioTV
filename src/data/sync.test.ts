import { describe, expect, it } from "vitest";
import {
  createNuvioFake,
  testAddon,
  testList,
  type NuvioFake,
  type NuvioFakeOptions,
} from "../../scripts/test-streams/nuvio";
import type { DeviceView } from "./accountView";
import { memoryStorage } from "./memoryStorage";
import { startPairing, waitForOwner } from "./pairing";
import { buildView, cleanSite, createSync, DEFAULT_SITE, readSync } from "./sync";

const BASE = "http://test.local:8090";
const SITE = "http://sync.test";
const PULL = "/rest/v1/rpc/sync_pull_profiles";
const REFRESH = "/auth/v1/token";

/** A colour as text: the build turns colour literals into numbers. */
const hex = (digits: string) => "#".concat(digits);

interface Clock {
  now: number;
}

/** The fake as the TV's fetch, counting the calls to each path. */
const serve = (fake: NuvioFake, offline: () => boolean) => {
  const counts: Record<string, number> = {};
  const fetcher: typeof fetch = async (input, init) => {
    if (offline()) throw new TypeError("Failed to fetch");
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    counts[path] = (counts[path] ?? 0) + 1;
    return fake.fetch(request);
  };
  return { fetcher, counts };
};

const newTv = (fake: NuvioFake, clock: Clock) => {
  const storage = memoryStorage();
  let offline = false;
  const { fetcher, counts } = serve(fake, () => offline);
  const views: { view: DeviceView; before?: DeviceView }[] = [];
  const signedOut: { view?: DeviceView; byAccount: boolean }[] = [];
  const sync = createSync({
    storage,
    fetch: fetcher,
    now: () => clock.now,
    mainProfileName: () => "Main",
    deviceName: () => "Test TV",
    onView: (view, before) => views.push({ view, before }),
    onSignedOut: (view, byAccount) => signedOut.push({ view, byAccount }),
  });
  sync.setSite(SITE);
  const goOffline = (is: boolean) => {
    offline = is;
  };
  return { sync, storage, fetcher, counts, views, signedOut, clock, goOffline };
};

/** An account on a fake Nuvio server, and a signed-out TV, sharing a clock. */
const setup = (options: Partial<NuvioFakeOptions> = {}) => {
  const clock: Clock = { now: 1_000_000 };
  const fake = createNuvioFake({ base: BASE, site: SITE, now: () => clock.now, ...options });
  return { fake, tv: newTv(fake, clock) };
};

type Tv = ReturnType<typeof newTv>;

/** Signs a TV in with its typed code, as the owner would type it. */
const signIn = async (fake: NuvioFake, tv: Tv) => {
  const pairing = await startPairing(SITE, "Test TV", tv.fetcher, () => tv.clock.now);
  fake.approve(pairing.userCode ?? "");
  const step = await waitForOwner(
    pairing,
    tv.fetcher,
    () => tv.clock.now,
    () => Promise.resolve(),
  ).done;
  if (step?.status !== "done") throw new Error(`Not signed in: ${JSON.stringify(step)}`);
  return tv.sync.signIn(step.server, step.session);
};

const kept = (tv: Tv) => readSync(JSON.parse(tv.storage.getItem("velio.sync") ?? "null"));
const names = (view: DeviceView | undefined) => view?.lists.map(list => list.name);
const profileNamed = (view: DeviceView | undefined, name: string) =>
  view?.profiles.find(profile => profile.name === name);
const listsOf = (view: DeviceView | undefined, name: string) =>
  profileNamed(view, name)?.lists.map(id => view?.lists.find(list => list.id === id)?.name);

describe("the server address", () => {
  it("cleans an address as typed", () => {
    expect(cleanSite("")).toBe(DEFAULT_SITE);
    expect(cleanSite("  ")).toBe(DEFAULT_SITE);
    expect(cleanSite("Sync.Example.com")).toBe("https://sync.example.com");
    expect(cleanSite("http://192.168.1.20:8787/")).toBe("http://192.168.1.20:8787");
    expect(cleanSite("example.com:8443")).toBe("https://example.com:8443");
    expect(cleanSite("HTTPS://example.com/Velio//")).toBe("https://example.com/Velio");
  });

  it("refuses what isn't an address", () => {
    for (const typed of [
      "ftp://example.com",
      "https://",
      "exa mple.com",
      "https://a.com?x=1",
      "https://u:p@a.com",
    ])
      expect(cleanSite(typed)).toBeUndefined();
  });

  it("changes only while signed out, and is kept", async () => {
    const { fake, tv } = setup();
    expect(tv.sync.setSite("not an address!")).toBe(false);
    expect(tv.sync.site()).toBe(SITE);
    expect(tv.sync.setSite("example.com/velio/")).toBe(true);
    expect(tv.sync.site()).toBe("https://example.com/velio");
    expect(kept(tv).site).toBe("https://example.com/velio");
    expect(tv.sync.setSite("")).toBe(true);
    expect(tv.sync.site()).toBe(DEFAULT_SITE);
    tv.sync.setSite(SITE);
    await signIn(fake, tv);
    expect(tv.sync.setSite("https://example.com")).toBe(false);
    expect(tv.sync.site()).toBe(SITE);
  });
});

describe("the account on the TV", () => {
  it("signs in with a typed code, registers the TV, and pulls every profile's lists", async () => {
    const { fake, tv } = setup();
    expect((await signIn(fake, tv)).result).toBe("changed");
    const view = tv.sync.view();
    expect(view?.profiles.map(profile => [profile.id, profile.name, profile.color])).toEqual([
      ["1", "Living room", hex("E53935")],
      ["2", "Kids", hex("43A047")],
      ["3", "Guest", hex("8E24AA")],
    ]);
    // A list two profiles share comes once, in the account's order.
    expect(names(view)).toEqual(["Test channels", "Kids channels", "Test Xtream", "Guest channels"]);
    expect(listsOf(view, "Living room")).toEqual(["Test channels", "Test Xtream"]);
    expect(listsOf(view, "Kids")).toEqual(["Test channels", "Kids channels"]);
    expect(view?.lists[0]).toEqual({
      id: view?.lists[0].id,
      name: "Test channels",
      kind: "m3u",
      url: testList(BASE, "Test channels").url,
      refreshHours: 24,
    });
    expect(view?.lists[2]).toMatchObject({
      kind: "xtream",
      server: BASE,
      username: "small",
      password: "small",
    });
    expect(tv.views).toHaveLength(1);
    // Kept across a restart.
    expect(kept(tv).view).toEqual(view);
    expect(fake.summary().devices).toEqual([
      { name: "Test TV", client: "Velio TV", platform: "tv", signedIn: true },
    ]);
    expect(tv.storage.getItem("velio.installation")).toMatch(/^velio-tv-[0-9a-f]{32}$/);
  });

  it("answers the same when nothing changed, and writes nothing", async () => {
    const { fake, tv } = setup();
    await signIn(fake, tv);
    // Checking a PIN changes the profile's updated_at, which isn't in the view.
    await tv.sync.checkPin("2", "0000");
    let writes = 0;
    const setItem = tv.storage.setItem.bind(tv.storage);
    tv.storage.setItem = (key, value) => {
      writes++;
      setItem(key, value);
    };
    expect(await tv.sync.pull()).toEqual({ result: "same" });
    expect(writes).toBe(0);
    expect(tv.views).toHaveLength(1);
    expect(tv.sync.status()).toMatchObject({ pulling: false, last: { result: "same" } });
    expect(tv.sync.connected()).toBe(true);
  });

  it("brings a list added, drops one taken away, and takes a changed address", async () => {
    const { fake, tv } = setup();
    await signIn(fake, tv);
    const before = tv.sync.view();
    fake.addList(testList(BASE, "New list", 5), ["Kids"]);
    fake.changeList("Test channels", {}, ["Living room"]);
    fake.changeList("Kids channels", { url: `${BASE}/playlist.m3u?channels=30` });
    fake.removeList("Guest channels");
    expect((await tv.sync.pull()).result).toBe("changed");
    const view = tv.sync.view();
    expect(listsOf(view, "Kids")).toEqual(["Kids channels", "New list"]);
    expect(listsOf(view, "Guest")).toEqual([]);
    expect(names(view)).not.toContain("Guest channels");
    expect(view?.lists.find(list => list.name === "Kids channels")?.url).toBe(
      `${BASE}/playlist.m3u?channels=30`,
    );
    expect(tv.views[1]?.before).toEqual(before);
  });

  it("gives a list for every profile to each, and a profile's add-ons to it", async () => {
    const { fake, tv } = setup();
    fake.addList(testList(BASE, "Everyone's", 5), []);
    fake.addList(testAddon(BASE, "Test add-on"), ["Living room", "Kids"]);
    await signIn(fake, tv);
    const view = tv.sync.view();
    expect(listsOf(view, "Guest")).toEqual(["Guest channels", "Everyone's"]);
    expect(listsOf(view, "Kids")).toEqual(["Test channels", "Kids channels", "Everyone's", "Test add-on"]);
    // Nuvio keeps an add-on for each profile.
    expect(view?.lists.filter(list => list.kind === "stremio").map(list => list.url)).toEqual([
      `${BASE}/stremio/manifest.json`,
      `${BASE}/stremio/manifest.json`,
    ]);
    // A profile that uses the main one's add-ons has those.
    fake.usePrimaryAddons("Guest", true);
    await tv.sync.pull();
    expect(listsOf(tv.sync.view(), "Guest")).toEqual(["Guest channels", "Everyone's", "Test add-on"]);
    // One turned off still comes, marked.
    fake.changeList("Test add-on", { disabled: true });
    await tv.sync.pull();
    expect(tv.sync.view()?.lists.find(list => list.kind === "stremio")?.disabled).toBe(true);
  });

  it("follows a renamed or removed profile", async () => {
    const { fake, tv } = setup();
    await signIn(fake, tv);
    fake.renameProfile("Guest", "Visitors");
    fake.removeProfile("Kids");
    await tv.sync.pull();
    expect(tv.sync.view()?.profiles.map(profile => profile.name)).toEqual(["Living room", "Visitors"]);
    expect(names(tv.sync.view())).toEqual(["Test channels", "Test Xtream", "Guest channels"]);
  });

  it("works with Nuvio's own server, which has no IPTV lists", async () => {
    const { fake, tv } = setup({ noIptvLists: true });
    fake.addList(testAddon(BASE, "Test add-on"), ["Living room"]);
    expect((await signIn(fake, tv)).result).toBe("changed");
    expect(names(tv.sync.view())).toEqual(["Test add-on"]);
  });

  it("checks a profile's PIN with the server, which waits after too many wrong ones", async () => {
    const { fake, tv } = setup();
    await signIn(fake, tv);
    expect(profileNamed(tv.sync.view(), "Kids")?.locked).toBeUndefined();
    fake.setPin("Kids", "1234");
    await tv.sync.pull();
    expect(profileNamed(tv.sync.view(), "Kids")?.locked).toBe(true);
    expect(await tv.sync.checkPin("2", "1234")).toEqual({ result: "unlocked" });
    for (let tries = 1; tries < 5; tries++)
      expect(await tv.sync.checkPin("2", "0000")).toEqual({ result: "wrong" });
    expect(await tv.sync.checkPin("2", "0000")).toEqual({ result: "locked", seconds: 300 });
    // Even the right one waits.
    expect(await tv.sync.checkPin("2", "1234")).toEqual({ result: "locked", seconds: 300 });
    tv.clock.now += 301_000;
    expect(await tv.sync.checkPin("2", "1234")).toEqual({ result: "unlocked" });
    tv.goOffline(true);
    expect((await tv.sync.checkPin("2", "1234")).result).toBe("failed");
  });

  it("refreshes its session before it runs out, and after a 401", async () => {
    const { fake, tv } = setup({ accessSeconds: 120 });
    await signIn(fake, tv);
    const first = tv.sync.saved().session;
    // Within a minute of the end: refreshed first.
    tv.clock.now += 70_000;
    expect((await tv.sync.pull()).result).toBe("same");
    expect(tv.sync.saved().session?.refresh).not.toBe(first?.refresh);
    expect(tv.counts[REFRESH]).toBe(1);
    // A TV whose clock is behind sends a token that ran out: a 401, then a refresh.
    tv.clock.now += 200_000;
    const behind = createSync({
      storage: tv.storage,
      fetch: tv.fetcher,
      now: () => tv.clock.now - 3_600_000,
    });
    expect((await behind.pull()).result).toBe("same");
    expect(tv.counts[REFRESH]).toBe(2);
    expect(behind.signedIn()).toBe(true);
  });

  it("refreshes once, however many calls need it", async () => {
    const { fake, tv } = setup({ accessSeconds: 120 });
    await signIn(fake, tv);
    tv.clock.now += 200_000;
    await Promise.all([tv.sync.pull(), tv.sync.checkPin("1", "0000"), tv.sync.checkPin("2", "0000")]);
    expect(tv.counts[REFRESH]).toBe(1);
    expect(tv.sync.signedIn()).toBe(true);
  });

  it("signs out when the account signs the TV out, and says so once", async () => {
    const { fake, tv } = setup();
    await signIn(fake, tv);
    const view = tv.sync.view();
    fake.removeDevice();
    expect(await tv.sync.pull()).toEqual({ result: "removed" });
    expect(tv.sync.signedIn()).toBe(false);
    expect(tv.sync.view()).toBeUndefined();
    expect(tv.signedOut).toEqual([{ view, byAccount: true }]);
    expect(tv.sync.signedOutNotice()).toBe(true);
    tv.sync.dismissNotice();
    expect(tv.sync.signedOutNotice()).toBe(false);
    expect(kept(tv)).toEqual({ site: SITE });
  });

  it("signs out when the account is closed", async () => {
    const { fake, tv } = setup();
    await signIn(fake, tv);
    fake.close();
    expect((await tv.sync.pull()).result).toBe("removed");
    expect(tv.signedOut[0]?.byAccount).toBe(true);
  });

  it("stays signed in, with its view, when the server can't be reached", async () => {
    const { fake, tv } = setup({ accessSeconds: 120 });
    await signIn(fake, tv);
    const view = tv.sync.view();
    tv.goOffline(true);
    tv.clock.now += 200_000;
    expect(await tv.sync.pull()).toMatchObject({ result: "failed", offline: true });
    expect(tv.sync.signedIn()).toBe(true);
    expect(tv.sync.connected()).toBe(false);
    expect(tv.sync.view()).toEqual(view);
    tv.goOffline(false);
    expect((await tv.sync.pull()).result).toBe("same");
    expect(tv.sync.connected()).toBe(true);
  });

  it("signs out on the user's choice, telling the server", async () => {
    const { fake, tv } = setup();
    await signIn(fake, tv);
    expect(fake.summary().tvsSignedIn).toBe(1);
    await tv.sync.signOut();
    expect(tv.counts["/auth/v1/logout"]).toBe(1);
    expect(fake.summary().tvsSignedIn).toBe(0);
    expect(tv.sync.signedIn()).toBe(false);
    expect(tv.sync.signedOutNotice()).toBe(false);
    expect(tv.signedOut[0]?.byAccount).toBe(false);
    expect(kept(tv)).toEqual({ site: SITE });
  });

  it("signs out even when the server can't be reached", async () => {
    const { fake, tv } = setup();
    await signIn(fake, tv);
    tv.goOffline(true);
    await tv.sync.signOut();
    expect(tv.sync.signedIn()).toBe(false);
  });

  it("runs one pull at a time, and once more for those asked meanwhile", async () => {
    const { fake, tv } = setup();
    await signIn(fake, tv);
    const before = tv.counts[PULL] ?? 0;
    const outcomes = await Promise.all([tv.sync.pull(), tv.sync.pull(), tv.sync.pull()]);
    expect((tv.counts[PULL] ?? 0) - before).toBe(2);
    expect(outcomes.map(outcome => outcome.result)).toEqual(["same", "same", "same"]);
  });

  it("keeps nothing from a pull that outlived its sign-in", async () => {
    const { fake, tv } = setup();
    await signIn(fake, tv);
    fake.addList(testList(BASE, "New list", 5), ["Kids"]);
    const pulling = tv.sync.pull();
    await tv.sync.signOut();
    expect((await pulling).result).toBe("signedOut");
    expect(tv.sync.view()).toBeUndefined();
  });

  it("reads nothing kept that doesn't fit", () => {
    expect(readSync(null)).toEqual({ site: DEFAULT_SITE });
    expect(readSync({ site: "https://a.example", session: { access: "a" } })).toEqual({
      site: "https://a.example",
    });
    expect(readSync({ site: "nope nope", signedOutNotice: true })).toEqual({
      site: DEFAULT_SITE,
      signedOutNotice: true,
    });
  });
});

describe("the view", () => {
  it("has Nuvio's main profile on an account that made none", () => {
    expect(
      buildView([], [{ id: "a", url: "https://addon.example/manifest.json", profile_id: 1 }], [], "Main"),
    ).toEqual({
      profiles: [{ id: "1", name: "Main", color: hex("1E88E5"), lists: ["a"] }],
      lists: [
        {
          id: "a",
          name: "addon.example",
          kind: "stremio",
          url: "https://addon.example/manifest.json",
          refreshHours: 24,
        },
      ],
    });
  });

  it("leaves out what it doesn't know, and what no profile uses", () => {
    const view = buildView(
      [{ profile_index: 2, name: "Two", avatar_color_hex: "red" }, { name: "No index" }],
      [{ id: "b", url: "https://b.example/manifest.json", profile_id: 5 }],
      [
        { id: "x", kind: "dvb" },
        { id: "y", kind: "m3u", url: "https://y.example/list.m3u", profile_ids: [9] },
      ],
      "Main",
    );
    expect(view).toEqual({
      profiles: [{ id: "2", name: "Two", color: hex("1E88E5"), lists: [] }],
      lists: [],
    });
  });
});
