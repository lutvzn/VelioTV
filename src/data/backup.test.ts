import { describe, expect, it } from "vitest";
import { defaultSettings } from "./appSettings";
import { fetchBackup, makeBackup, readBackup, sendBackup } from "./backup";
import { emptyEdits } from "./channelEdits";

const parts = {
  sources: [{ id: "a", name: "A", kind: "m3u" as const, url: "http://a/p.m3u", refreshHours: 24 }],
  edits: { ...emptyEdits(), favourites: ["a/n:one"] },
  settings: { ...defaultSettings(), pin: "1234" },
};

describe("backups", () => {
  it("go out with PUT and come back with GET as they were", async () => {
    const stored = new Map<string, string>();
    const server: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (init?.method === "PUT") {
        stored.set(url, typeof init.body === "string" ? init.body : "");
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const body = stored.get(url);
      return Promise.resolve(body === undefined ? new Response("", { status: 404 }) : new Response(body));
    };
    const backup = makeBackup(parts, 5);
    await sendBackup("http://b/backup/tv.json", backup, server);
    expect(await fetchBackup("http://b/backup/tv.json", server)).toEqual(backup);
    await expect(fetchBackup("http://b/backup/other.json", server)).rejects.toThrow("HTTP 404");
    await expect(fetchBackup("b/backup.json", server)).rejects.toThrow("backup.problem.url");
  });

  it("are read leaving out what doesn't fit, and refused when they aren't backups", () => {
    const read = readBackup({ ...makeBackup(parts, 5), sources: [{ id: 1 }, ...parts.sources], edits: "x" });
    expect(read.sources).toEqual(parts.sources);
    expect(read.edits).toEqual(emptyEdits());
    expect(() => readBackup({ app: "other" })).toThrow("backup.problem.notBackup");
    expect(() => readBackup({ app: "tiviplayer", version: 2 })).toThrow("backup.problem.version");
  });
});
