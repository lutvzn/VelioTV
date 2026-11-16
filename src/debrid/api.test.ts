import { describe, expect, it } from "vitest";
import { clientFor, failKind } from "./api";
import type { ServiceId } from "./services";

// Each service's calls, against a made-up server that answers as its API
// does (src/debrid/api.ts names where each call comes from).

const HASH = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const torrent = { infoHash: HASH, sources: [] as string[] };

interface Asked {
  method: string;
  path: string;
  query: string;
  body: string;
  auth: string;
}
type Route = (asked: Asked) => [number, unknown];

/** A fake fetch: each "METHOD /path" answers with its route; the calls are kept. */
const server = (routes: Record<string, Route>) => {
  const calls: Asked[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    const body = init?.body;
    const asked: Asked = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.search,
      body:
        typeof body === "string"
          ? body
          : body instanceof FormData
            ? [...body.entries()]
                .map(([key, value]) => `${key}=${typeof value === "string" ? value : value.name}`)
                .join("&")
            : "",
      auth: headers.get("Authorization") ?? "",
    };
    calls.push(asked);
    const route = routes[`${asked.method} ${asked.path}`];
    const [status, answer] = route ? route(asked) : [404, { error: "no route" }];
    return new Response(status === 204 ? null : JSON.stringify(answer), { status });
  };
  return { fetch: fetcher, calls };
};

const client = (id: ServiceId, routes: Record<string, Route>) => {
  const fake = server(routes);
  return { ...clientFor(id, "KEY", { fetch: fake.fetch, sleep: async () => undefined }), calls: fake.calls };
};

const kindOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return failKind(error);
  }
};

describe("TorBox", () => {
  it("play a cached torrent's file", async () => {
    const torbox = client("torbox", {
      "POST /v1/api/torrents/createtorrent": () => [200, { success: true, data: { torrent_id: 7 } }],
      "GET /v1/api/torrents/mylist": () => [
        200,
        {
          data: {
            files: [
              { id: 0, name: "Film/Film.mkv", size: 2000, mimetype: "video/x-matroska" },
              { id: 1, name: "Film/Sample.mkv", size: 20 },
            ],
          },
        },
      ],
      "GET /v1/api/torrents/requestdl": () => [
        200,
        { success: true, data: "https://cdn.example.invalid/film.mkv" },
      ],
    });
    expect(await torbox.resolve({ torrent })).toEqual({
      url: "https://cdn.example.invalid/film.mkv",
      filename: "Film.mkv",
      sizeBytes: 2000,
    });
    expect(torbox.calls[0].body).toContain("add_only_if_cached=true");
    expect(torbox.calls[0].auth).toBe("Bearer KEY");
    expect(torbox.calls[2].query).toContain("torrent_id=7&file_id=0");
  });

  it("say a torrent isn't cached, and a key is refused", async () => {
    const missing = client("torbox", {
      "POST /v1/api/torrents/createtorrent": () => [409, { success: false }],
    });
    expect(await kindOf(missing.resolve({ torrent }))).toBe("notCached");
    // One already in the account, still being fetched, comes back with its id.
    const fetching = client("torbox", {
      "POST /v1/api/torrents/createtorrent": () => [200, { success: true, data: { torrent_id: 8 } }],
      "GET /v1/api/torrents/mylist": () => [
        200,
        { data: { download_state: "checking", download_finished: false, cached: false, files: [] } },
      ],
    });
    expect(await kindOf(fetching.resolve({ torrent }))).toBe("notCached");
    const refused = client("torbox", { "POST /v1/api/torrents/createtorrent": () => [401, {}] });
    expect(await kindOf(refused.resolve({ torrent }))).toBe("key");
  });

  it("check which torrents it has, with its own hash for one it knows by another", async () => {
    const torbox = client("torbox", {
      "POST /v1/api/torrents/checkcached": asked => {
        const hashes = asked.body.match(/[0-9a-f]{40}/g) ?? [];
        // It knows OTHER as "ffff…", and HASH by its own.
        if (hashes.length > 1)
          return [200, { data: { [HASH]: { name: "a" }, ["f".repeat(40)]: { name: "b" } } }];
        return [200, { data: hashes[0] === OTHER ? { ["f".repeat(40)]: { name: "b" } } : {} }];
      },
    });
    const third = "1".repeat(40);
    const found = (await torbox.check?.([HASH, OTHER, third])) ?? new Set<string>();
    expect(found).toEqual(new Set([HASH, OTHER]));
  });
});

describe("Real-Debrid", () => {
  it("play a torrent it has, choosing the file", async () => {
    let selected = false;
    const rd = client("realdebrid", {
      "POST /rest/1.0/torrents/addMagnet": () => [201, { id: "AB" }],
      "GET /rest/1.0/torrents/info/AB": () => [
        200,
        selected
          ? {
              status: "downloaded",
              files: [
                { id: 1, path: "/Film.mkv", bytes: 3000, selected: 1 },
                { id: 2, path: "/Film.nfo", bytes: 1, selected: 0 },
              ],
              links: ["https://real-debrid.com/d/LINK"],
            }
          : {
              status: "waiting_files_selection",
              files: [
                { id: 1, path: "/Film.mkv", bytes: 3000, selected: 0 },
                { id: 2, path: "/Film.nfo", bytes: 1, selected: 0 },
              ],
            },
      ],
      "POST /rest/1.0/torrents/selectFiles/AB": asked => {
        selected = asked.body === "files=1";
        return [204, ""];
      },
      "POST /rest/1.0/unrestrict/link": () => [
        200,
        { download: "https://cdn.example.invalid/Film.mkv", filename: "Film.mkv", filesize: 3000 },
      ],
    });
    expect(await rd.resolve({ torrent })).toEqual({
      url: "https://cdn.example.invalid/Film.mkv",
      filename: "Film.mkv",
      sizeBytes: 3000,
    });
    expect(rd.calls.some(call => call.method === "DELETE")).toBe(false);
  });

  it("delete a torrent it would have to fetch", async () => {
    const rd = client("realdebrid", {
      "POST /rest/1.0/torrents/addMagnet": () => [201, { id: "AB" }],
      "GET /rest/1.0/torrents/info/AB": () => [200, { status: "magnet_conversion", files: [] }],
      "DELETE /rest/1.0/torrents/delete/AB": () => [204, ""],
    });
    expect(await kindOf(rd.resolve({ torrent }))).toBe("notCached");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(rd.calls.slice(-1)[0]?.method).toBe("DELETE");
  });
});

describe("Premiumize", () => {
  it("check its cache and play a direct link", async () => {
    const pm = client("premiumize", {
      "POST /api/cache/check": () => [200, { status: "success", response: [true, false] }],
      "POST /api/transfer/directdl": () => [
        200,
        {
          status: "success",
          content: [{ path: "Film/Film.mp4", size: 500, link: "https://cdn.example.invalid/f.mp4" }],
        },
      ],
    });
    expect([...((await pm.check?.([HASH, OTHER])) ?? [])]).toEqual([HASH]);
    expect(pm.calls[0].query).toBe("?apikey=KEY");
    expect(pm.calls[0].body).toBe(`items%5B%5D=${HASH}&items%5B%5D=${OTHER}`);
    expect((await pm.resolve({ torrent })).url).toBe("https://cdn.example.invalid/f.mp4");
  });

  it("say a torrent isn't cached", async () => {
    const pm = client("premiumize", {
      "POST /api/transfer/directdl": () => [200, { status: "error", message: "Not cached" }],
    });
    expect(await kindOf(pm.resolve({ torrent }))).toBe("notCached");
  });
});

describe("AllDebrid", () => {
  it("play a ready torrent, its files a tree", async () => {
    const ad = client("alldebrid", {
      "POST /v4/magnet/upload": () => [
        200,
        { status: "success", data: { magnets: [{ id: 9, hash: HASH, ready: true }] } },
      ],
      "GET /v4/magnet/files": () => [
        200,
        {
          status: "success",
          data: {
            magnets: [
              {
                id: "9",
                files: [
                  {
                    n: "Film",
                    e: [
                      { n: "Film.mkv", s: 4000, l: "https://alldebrid.com/f/X" },
                      { n: "a.txt", s: 1, l: "x" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
      "GET /v4/link/unlock": () => [
        200,
        { status: "success", data: { link: "https://cdn.example.invalid/Film.mkv" } },
      ],
    });
    expect(await ad.resolve({ torrent })).toEqual({
      url: "https://cdn.example.invalid/Film.mkv",
      filename: "Film.mkv",
      sizeBytes: 4000,
    });
    expect(ad.calls[0].query).toBe("?agent=VelioTV");
    expect(ad.calls[2].query).toContain(encodeURIComponent("https://alldebrid.com/f/X"));
  });

  it("delete a torrent that isn't ready, and read a refused key", async () => {
    const ad = client("alldebrid", {
      "POST /v4/magnet/upload": () => [
        200,
        { status: "success", data: { magnets: [{ id: 9, ready: false }] } },
      ],
      "GET /v4/magnet/delete": () => [200, { status: "success" }],
    });
    expect(await kindOf(ad.resolve({ torrent }))).toBe("notCached");
    expect(ad.calls.slice(-1)[0]?.path).toBe("/v4/magnet/delete");
    const refused = client("alldebrid", {
      "GET /v4/user": () => [
        200,
        { status: "error", error: { code: "AUTH_BAD_APIKEY", message: "Bad key" } },
      ],
    });
    expect(await kindOf(refused.account())).toBe("key");
  });
});

describe("Debrid-Link", () => {
  it("play a torrent that's all there, and remove one that isn't", async () => {
    const dl = client("debridlink", {
      "POST /api/v2/seedbox/add": () => [
        200,
        {
          success: true,
          value: {
            id: "S1",
            downloadPercent: 100,
            files: [
              {
                id: "S1-0",
                name: "Film.mkv",
                size: 700,
                downloadUrl: "https://cdn.example.invalid/Film.mkv",
              },
            ],
          },
        },
      ],
    });
    expect((await dl.resolve({ torrent })).url).toBe("https://cdn.example.invalid/Film.mkv");
    const partial = client("debridlink", {
      "POST /api/v2/seedbox/add": () => [
        200,
        { success: true, value: { id: "S2", downloadPercent: 3, files: [] } },
      ],
      "DELETE /api/v2/seedbox/S2/remove": () => [200, { success: true }],
    });
    expect(await kindOf(partial.resolve({ torrent }))).toBe("notCached");
    expect(partial.calls.slice(-1)[0]?.path).toBe("/api/v2/seedbox/S2/remove");
  });
});

describe("EasyDebrid", () => {
  it("check its cache and play a generated link", async () => {
    const ed = client("easydebrid", {
      "POST /api/v1/link/lookupdetails": () => [200, { result: [{ cached: false }, { cached: true }] }],
      "POST /api/v1/link/generate": () => [
        200,
        {
          files: [
            {
              filename: "Film.mp4",
              directory: ["Film"],
              size: 900,
              url: "https://cdn.example.invalid/Film.mp4",
            },
          ],
        },
      ],
    });
    expect([...((await ed.check?.([HASH, OTHER])) ?? [])]).toEqual([OTHER]);
    expect(await ed.resolve({ torrent })).toEqual({
      url: "https://cdn.example.invalid/Film.mp4",
      filename: "Film.mp4",
      sizeBytes: 900,
    });
  });
});

describe("Offcloud", () => {
  it("not add a torrent it doesn't have", async () => {
    const oc = client("offcloud", {
      "POST /api/cache/info": () => [200, [{ cached: false }]],
    });
    expect(await kindOf(oc.resolve({ torrent }))).toBe("notCached");
    expect(oc.calls.map(call => call.path)).toEqual(["/api/cache/info"]);
  });

  it("play a cached torrent's file", async () => {
    const oc = client("offcloud", {
      "POST /api/cache/info": () => [200, [{ cached: true }]],
      "POST /api/cloud": () => [200, { requestId: "R1", status: "downloaded", fileName: "Film" }],
      "GET /api/cloud/explore/R1": () => [
        200,
        {
          files: [
            {
              id: "1",
              name: "Film.mkv",
              path: "Film/Film.mkv",
              size: 800,
              url: "https://cdn.example.invalid/1",
            },
          ],
        },
      ],
    });
    expect((await oc.resolve({ torrent })).url).toBe("https://cdn.example.invalid/1");
  });
});
