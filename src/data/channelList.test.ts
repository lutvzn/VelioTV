import { describe, expect, it } from "vitest";
import { fromColumns, toColumns } from "./channelList";
import type { PlaylistChannel } from "./types";

const channels: PlaylistChannel[] = [
  { index: 0, name: "One", url: "http://a/1.ts", guideId: "one.tv", number: 1, group: "News" },
  { index: 1, name: "Two", url: "http://a/2.ts", logo: "http://a/2.png", headers: { referer: "http://a/" } },
  {
    index: 2,
    name: "Three, with a comma",
    url: "http://a/3.ts",
    group: "News",
    catchup: { type: "append", days: 3, source: "?utc={utc}" },
    providerId: "3",
  },
];

describe("channel columns", () => {
  it("give back the same channels", () => {
    expect(fromColumns(toColumns(channels), "s")).toEqual(
      channels.map(channel => ({
        ...channel,
        source: "s",
        id: `s/${channel.providerId ? `i:${channel.providerId}` : `n:${channel.name.toLowerCase()}`}`,
      })),
    );
    expect(fromColumns(toColumns([]), "s")).toEqual([]);
  });

  it("key channels at import, and lists stored without keys as they're read", () => {
    const columns = toColumns(channels);
    expect(columns.key).toEqual(["n:one", "n:two", "i:3"]);
    const { key: _key, ...old } = columns;
    expect(fromColumns(old, "s").map(channel => channel.id)).toEqual(["s/n:one", "s/n:two", "s/i:3"]);
  });

  it("only hold columns for fields some channel has", () => {
    const columns = toColumns(channels.slice(0, 1));
    const present = Object.entries(columns.optional).filter(([, column]) => column !== undefined);
    expect(new Set(present.map(([field]) => field))).toEqual(new Set(["group", "guideId", "number"]));
    expect(columns).toMatchObject({ count: 1, name: ["One"], url: ["http://a/1.ts"] });
  });
});
