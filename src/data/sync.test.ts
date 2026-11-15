import { isRecord } from "../sync-core/crypto";
import { describe, expect, it } from "vitest";
import { createSyncMock, testList, type SyncMock } from "../../scripts/test-streams/sync";
import { makeTestAccount, openForDevice, testDeviceKeys } from "../sync-core";
import { openPull, type DeviceView } from "../sync-core/device";
import { memoryStorage } from "./memoryStorage";
import { startPairing, waitForOwner } from "./pairing";
import { cleanSite, createSync, DEFAULT_SITE, readSync, type PullOpener } from "./sync";
import { openInWorker } from "./syncOpen";

const BASE = "http://test.local:8090";
const SITE = "http://sync.test";

/** The mock as the TV's fetch, counting requests to /v1/sync. */
const serve = (mock: SyncMock) => {
  const counts = { sync: 0 };
  const fetcher: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/v1/sync") counts.sync++;
    return mock.fetch(request);
  };
  return { fetcher, counts };
};

const openHere: PullOpener = (trust, pull, previous) => Promise.resolve(openPull(trust, pull, previous));

const newTv = (mock: SyncMock, open: PullOpener = openHere) => {
  const storage = memoryStorage();
  const { fetcher, counts } = serve(mock);
  const views: { view: DeviceView; before?: DeviceView }[] = [];
  const signedOut: { view?: DeviceView; byAccount: boolean }[] = [];
  const sync = createSync({
    storage,
    open,
    fetch: fetcher,
    onView: (view, before) => views.push({ view, before }),
    onSignedOut: (view, byAccount) => signedOut.push({ view, byAccount }),
  });
  sync.setSite(SITE);
  return { sync, storage, fetcher, counts, views, signedOut };
};

/** Signs a TV in with a typed code, as the phone would read it, giving it `profiles`. */
const signIn = async (mock: SyncMock, tv: ReturnType<typeof newTv>, profiles?: string[]) => {
  const pairing = await startPairing(SITE, "Test TV", tv.fetcher);
  const run = waitForOwner(pairing, tv.fetcher);
  mock.approve(pairing.code, profiles);
  const step = await run.done;
  if (step?.status !== "done") throw new Error(`Not signed in: ${JSON.stringify(step)}`);
  return tv.sync.signIn(step.trust, step.token);
};

const names = (view: DeviceView | undefined) => view?.lists.map(list => list.name);

const removed: PullOpener = () => {
  const error = new Error("This TV is no longer signed in to the account");
  error.name = "DeviceRemoved";
  return Promise.reject(error);
};

describe("sync-core in VelioTV", () => {
  it("opens sync-core's test account", () => {
    const account = makeTestAccount(20);
    const opened = openForDevice(account.pull, testDeviceKeys(account));
    expect(opened.profiles.map(profile => profile.name)).toEqual(account.expect.profiles);
    expect(opened.profiles[0].lists[0].name).toBe(account.expect.firstList);
  });
});

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
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    expect(tv.sync.setSite("not an address!")).toBe(false);
    expect(tv.sync.site()).toBe(SITE);
    expect(tv.sync.setSite("example.com/velio/")).toBe(true);
    expect(tv.sync.site()).toBe("https://example.com/velio");
    expect(readSync(JSON.parse(tv.storage.getItem("velio.sync") ?? "null")).site).toBe(
      "https://example.com/velio",
    );
    expect(tv.sync.setSite("")).toBe(true);
    expect(tv.sync.site()).toBe(DEFAULT_SITE);
    tv.sync.setSite(SITE);
    await signIn(mock, tv);
    expect(tv.sync.setSite("https://example.com")).toBe(false);
    expect(tv.sync.site()).toBe(SITE);
  });
});

describe("Velio Sync on the TV", () => {
  it("signs in with a typed code and pulls its profiles' lists", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    const outcome = await signIn(mock, tv, ["Living room", "Kids"]);
    expect(outcome.result).toBe("changed");
    const view = tv.sync.view();
    expect(view?.profiles.map(profile => profile.name)).toEqual(["Living room", "Kids"]);
    // A list two profiles share comes once.
    expect(names(view)).toEqual(["Test channels", "Kids channels", "Test Xtream"]);
    expect(view?.lists[0].url).toBe(testList(BASE, "Test channels").url);
    expect(tv.views).toHaveLength(1);
    // Kept across a restart.
    expect(readSync(JSON.parse(tv.storage.getItem("velio.sync") ?? "null")).view).toEqual(view);
    expect(mock.summary().devices[0]).toMatchObject({ profiles: ["Living room", "Kids"], signedIn: true });
  });

  it("answers 304 when nothing changed, and writes nothing", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv);
    const before = tv.storage.getItem("velio.sync");
    let writes = 0;
    const setItem = tv.storage.setItem.bind(tv.storage);
    tv.storage.setItem = (key, value) => {
      writes++;
      setItem(key, value);
    };
    expect(await tv.sync.pull()).toEqual({ result: "same" });
    expect(writes).toBe(0);
    expect(tv.storage.getItem("velio.sync")).toBe(before);
    expect(tv.sync.status()).toMatchObject({ pulling: false, last: { result: "same" } });
  });

  it("brings a list added to one of its profiles, reusing the lists that didn't change", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv, ["Living room", "Kids"]);
    const before = tv.sync.view();
    mock.addList(testList(BASE, "New list", 5), ["Kids"]);
    const outcome = await tv.sync.pull();
    expect(outcome.result).toBe("changed");
    expect(names(tv.sync.view())).toContain("New list");
    expect(tv.sync.view()?.profiles[1].lists).toHaveLength(3);
    // Opened again only if its revision changed.
    expect(tv.sync.view()?.lists[0]).toBe(before?.lists[0]);
    expect(tv.views[1].before).toBe(before);
  });

  it("drops a list taken from its profiles, and a list on another profile never shows", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv, ["Kids"]);
    expect(names(tv.sync.view())).toEqual(["Test channels", "Kids channels"]);
    mock.addList(testList(BASE, "Guest only", 5), ["Guest"]);
    mock.changeList("Test channels", {}, ["Living room"]);
    await tv.sync.pull();
    expect(names(tv.sync.view())).toEqual(["Kids channels"]);
  });

  it("takes a changed address, and a PIN set on the web", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv);
    mock.changeList("Kids channels", { url: `${BASE}/playlist.m3u?channels=30` });
    mock.setPin("Kids", "1234");
    await tv.sync.pull();
    const view = tv.sync.view();
    expect(view?.lists.find(list => list.name === "Kids channels")?.url).toBe(
      `${BASE}/playlist.m3u?channels=30`,
    );
    expect(view?.profiles.find(profile => profile.name === "Kids")?.pin).toBe("1234");
  });

  it("refuses a pull older than the one it has, and keeps its view", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv);
    // What the first pull answered, as a server replaying it would.
    const first = await mock.fetch(
      new Request(`${SITE}/v1/sync`, { headers: { Authorization: `Bearer ${tv.sync.saved().token}` } }),
    );
    const replay = await first.text();
    mock.addList(testList(BASE, "Later", 5), ["Guest"]);
    await tv.sync.pull();
    const view = tv.sync.view();

    const storage = memoryStorage();
    storage.setItem("velio.sync", JSON.stringify(tv.sync.saved()));
    const stale = createSync({
      storage,
      open: openHere,
      fetch: () => Promise.resolve(new Response(replay, { status: 200 })),
    });
    expect(await stale.pull()).toMatchObject({
      result: "failed",
      problem: "The pull is older than the last one",
    });
    expect(stale.view()).toEqual(view);
    expect(stale.signedIn()).toBe(true);
  });

  it("refuses a manifest the owner didn't sign, and stays signed in", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv);
    const view = tv.sync.view();
    mock.addList(testList(BASE, "Signed?", 5), ["Kids"]);
    const tampering: typeof fetch = async (input, init) => {
      const response = await tv.fetcher(input, init);
      if (response.status !== 200) return response;
      const pull: unknown = await response.json();
      if (!isRecord(pull) || !isRecord(pull.manifest) || typeof pull.manifest.signature !== "string")
        throw new Error("Not a pull");
      const { signature } = pull.manifest;
      pull.manifest.signature = (signature.startsWith("A") ? "B" : "A") + signature.slice(1);
      return new Response(JSON.stringify(pull), { status: 200 });
    };
    const storage = memoryStorage();
    storage.setItem("velio.sync", JSON.stringify(tv.sync.saved()));
    const sync = createSync({ storage, open: openHere, fetch: tampering });
    const outcome = await sync.pull();
    expect(outcome).toMatchObject({ result: "failed", problem: "The signature doesn't match" });
    expect(sync.view()).toEqual(view);
    expect(sync.signedIn()).toBe(true);
  });

  it("signs out when the server says the TV was removed (401)", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv);
    const view = tv.sync.view();
    mock.removeDevice();
    expect(await tv.sync.pull()).toEqual({ result: "removed" });
    expect(tv.sync.signedIn()).toBe(false);
    expect(tv.sync.view()).toBeUndefined();
    expect(tv.sync.signedOutNotice()).toBe(true);
    expect(tv.signedOut).toEqual([{ view, byAccount: true }]);
    // The site stays; the notice goes once seen.
    expect(tv.sync.site()).toBe(SITE);
    tv.sync.dismissNotice();
    expect(tv.sync.signedOutNotice()).toBe(false);
  });

  it("signs out when the account is closed", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv);
    mock.close();
    expect(await tv.sync.pull()).toEqual({ result: "removed" });
    expect(tv.sync.signedIn()).toBe(false);
  });

  it("signs out when the manifest no longer names the TV", async () => {
    const mock = createSyncMock({ base: BASE });
    let calls = 0;
    const tv = newTv(mock, (trust, pull, previous) =>
      calls++ === 0 ? openHere(trust, pull, previous) : removed(trust, pull, previous),
    );
    await signIn(mock, tv);
    mock.addList(testList(BASE, "Another", 5), ["Kids"]);
    expect(await tv.sync.pull()).toEqual({ result: "removed" });
    expect(tv.sync.signedIn()).toBe(false);
  });

  it("signs out on the user's choice, telling the server", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv);
    const token = tv.sync.saved().token;
    await tv.sync.signOut();
    expect(tv.sync.signedIn()).toBe(false);
    expect(tv.sync.signedOutNotice()).toBe(false);
    expect(tv.signedOut[0].byAccount).toBe(false);
    expect(mock.summary().devices[0]).toMatchObject({ signedIn: false, signedOut: true });
    const after = await mock.fetch(
      new Request(`${SITE}/v1/sync`, { headers: { Authorization: `Bearer ${token}` } }),
    );
    expect(after.status).toBe(401);
  });

  it("signs out even when the server can't be reached", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv);
    const storage = memoryStorage();
    storage.setItem("velio.sync", JSON.stringify(tv.sync.saved()));
    const offline = createSync({
      storage,
      open: openHere,
      fetch: () => Promise.reject(new TypeError("offline")),
    });
    expect(await offline.pull()).toMatchObject({ result: "failed", offline: true });
    expect(offline.signedIn()).toBe(true);
    await offline.signOut();
    expect(offline.signedIn()).toBe(false);
  });

  it("runs one pull at a time, and once more for those asked meanwhile", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock);
    await signIn(mock, tv);
    const before = tv.counts.sync;
    const outcomes = await Promise.all([tv.sync.pull(), tv.sync.pull(), tv.sync.pull()]);
    expect(tv.counts.sync - before).toBe(2);
    expect(outcomes.map(outcome => outcome.result)).toEqual(["same", "same", "same"]);
  });

  it("opens a pull in the worker", async () => {
    const mock = createSyncMock({ base: BASE });
    const tv = newTv(mock, openInWorker);
    await signIn(mock, tv, ["Kids"]);
    expect(names(tv.sync.view())).toEqual(["Test channels", "Kids channels"]);
    // A worker's error keeps its name and text: a wrong key is a failed pull, not a sign-out.
    const other = createSyncMock({ base: BASE });
    const broken = newTv(other, (trust, pull, previous) =>
      openInWorker({ ...trust, signPublicKey: trust.boxPublicKey }, pull, previous),
    );
    expect(await signIn(other, broken)).toMatchObject({
      result: "failed",
      problem: "The signature doesn't match",
    });
    expect(broken.sync.signedIn()).toBe(true);
  });
});
