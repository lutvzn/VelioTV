import { afterEach, describe, expect, it } from "vitest";
import { catalog, guideWindow, programmesBetween } from "../../scripts/test-streams/catalog.mjs";
import { xmltv } from "../../scripts/test-streams/playlist.mjs";
import { playerApi } from "../../scripts/test-streams/xtream.mjs";
import { deleteDb, openDb, readChannels, readGuide, readImport } from "./db";
import { runImport } from "./importer";
import { normalizeServer, xtreamAccount, xtreamLiveChannels, type XtreamLogin } from "./xtream";

const BASE = "http://xtream.test:8080";
const DB = "velio-xtream-test";
const LOGIN: XtreamLogin = { server: BASE, username: "test", password: "test" };

const urlOf = (input: RequestInfo | URL) => (input instanceof Request ? input.url : input.toString());

// The test server's mock Xtream API, as a fetch.
const mockServer = (count: number): typeof fetch => {
  const account = { username: "test", password: "test", catalog: catalog(count) };
  const window = guideWindow(3);
  return input => {
    const url = new URL(urlOf(input));
    const login = url.searchParams.get("username") === "test" && url.searchParams.get("password") === "test";
    if (url.pathname === "/player_api.php") {
      const body = login
        ? playerApi(url, { account, base: BASE, host: url.host, now: Date.now(), window })
        : { user_info: { auth: 0 } };
      return Promise.resolve(new Response(JSON.stringify(body)));
    }
    if (url.pathname === "/xmltv.php" && login) {
      return Promise.resolve(
        new Response([...xmltv({ base: BASE, channels: account.catalog.channels, window })].join("")),
      );
    }
    return Promise.resolve(new Response("", { status: 404 }));
  };
};

// A server that answers every action with fixed JSON.
const fixedServer =
  (replies: Record<string, unknown>): typeof fetch =>
  input => {
    const action = new URL(urlOf(input)).searchParams.get("action") ?? "login";
    return Promise.resolve(new Response(JSON.stringify(replies[action])));
  };

afterEach(async () => {
  await deleteDb(DB);
});

describe("normalizeServer", () => {
  it("adds http, and drops trailing slashes and pasted API paths", () => {
    expect(normalizeServer("example.com:8080/")).toBe("http://example.com:8080");
    expect(normalizeServer("https://example.com/player_api.php?username=a&password=b")).toBe(
      "https://example.com",
    );
    expect(normalizeServer(" http://example.com/get.php?type=m3u ")).toBe("http://example.com");
  });
});

describe("xtreamAccount", () => {
  it("reads the account", async () => {
    const account = await xtreamAccount(LOGIN, mockServer(10));
    expect(account).toMatchObject({
      status: "Active",
      maxConnections: 2,
      isTrial: false,
      formats: ["m3u8", "ts"],
    });
    expect(account.expiresAt).toBeGreaterThan(Date.now());
  });

  it("throws for a wrong password", async () => {
    await expect(xtreamAccount({ ...LOGIN, password: "nope" }, mockServer(10))).rejects.toThrow(
      /login failed/,
    );
  });
});

describe("xtreamLiveChannels", () => {
  it("reads the test server's channels", async () => {
    const fetcher = mockServer(300);
    const account = await xtreamAccount(LOGIN, fetcher);
    const channels = await xtreamLiveChannels(LOGIN, account, fetcher);
    const expected = catalog(300).channels;
    expect(channels).toHaveLength(expected.length);
    for (const [i, channel] of channels.entries()) {
      const want = expected[i];
      expect(channel).toMatchObject({
        index: i,
        name: want.name,
        number: want.number,
        group: want.group,
        providerId: String(want.id),
        url: `${BASE}/live/test/test/${want.id}.ts`,
      });
      expect(channel.guideId).toBe(want.guideId ?? undefined);
      expect(channel.logo).toBe(want.logo ? `${BASE}${want.logo}` : undefined);
      expect(channel.catchup).toEqual(
        want.archiveDays ? { type: "xtream", days: want.archiveDays } : undefined,
      );
    }
  });

  it("copes with numbers sent as strings, and an account without TS", async () => {
    const fetcher = fixedServer({
      get_live_categories: [{ category_id: 4, category_name: "News" }],
      get_live_streams: [
        {
          stream_id: "17",
          name: "One",
          num: "3",
          category_id: "4",
          tv_archive: "1",
          tv_archive_duration: "2",
        },
        { stream_id: 18, name: "Two", epg_channel_id: null, stream_icon: "" },
        { name: "No id" },
      ],
    });
    const channels = await xtreamLiveChannels(LOGIN, { formats: ["m3u8"] }, fetcher);
    expect(channels).toEqual([
      {
        index: 0,
        name: "One",
        url: `${BASE}/live/test/test/17.m3u8`,
        providerId: "17",
        number: 3,
        group: "News",
        catchup: { type: "xtream", days: 2 },
      },
      { index: 1, name: "Two", url: `${BASE}/live/test/test/18.m3u8`, providerId: "18" },
    ]);
  });
});

describe("runImport with Xtream", () => {
  it("imports the channels and the guide from xmltv.php", async () => {
    const result = await runImport(
      { kind: "xtream", source: "x", ...LOGIN },
      { dbName: DB, fetch: mockServer(80) },
    );
    expect(result).toMatchObject({ status: "done", channels: 80, unmatchedProgrammes: 0 });
    expect(result.guideUrls).toEqual([`${BASE}/xmltv.php?username=test&password=test`]);
    expect(result.account?.status).toBe("Active");

    const db = await openDb(DB);
    expect(await readImport(db, "x")).toMatchObject({ status: "done", account: { maxConnections: 2 } });
    expect(await readChannels(db, "x")).toHaveLength(80);
    const window = guideWindow(3);
    const channel = catalog(80).channels.find(c => c.guideId);
    const from = window.start + 30 * 3_600_000;
    const to = from + 3 * 3_600_000;
    const list = await readGuide(db, "x", channel.guideId, from, to);
    expect(list.map(p => p.title)).toEqual(programmesBetween(channel, window, from, to).map(p => p.title));
    db.close();
  });

  it("fails with the login error, and stores nothing", async () => {
    await expect(
      runImport(
        { kind: "xtream", source: "x", ...LOGIN, password: "nope" },
        { dbName: DB, fetch: mockServer(10) },
      ),
    ).rejects.toThrow(/login failed/);
    const db = await openDb(DB);
    expect(await readImport(db, "x")).toMatchObject({ status: "failed" });
    expect(await readChannels(db, "x")).toEqual([]);
    db.close();
  });
});
