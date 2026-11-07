import { describe, expect, it } from "vitest";
import { baseKey, channelKeys, xtreamStreamId } from "./channelKey";

const channel = (name: string, url: string, extra: { group?: string; providerId?: string } = {}) => ({
  name,
  url,
  ...extra,
});

describe("channel keys", () => {
  it("use the provider's id, then an Xtream stream id, then the name", () => {
    expect(baseKey(channel("One", "http://a/x.m3u8", { providerId: "17" }))).toBe("i:17");
    expect(baseKey(channel("One", "http://p.tv:8080/live/user/pass/4521.ts"))).toBe("i:4521");
    expect(baseKey(channel("One", "http://p.tv/user/pass/4521?token=abc"))).toBe("i:4521");
    expect(baseKey(channel("  BBC   One HD ", "http://cdn/hls/bbc1/index.m3u8?t=123"))).toBe("n:bbc one hd");
    expect(baseKey(channel("One", "http://cdn/1.ts"))).toBe("n:one");
  });

  it("find the stream id only after two path segments", () => {
    expect(xtreamStreamId("http://p.tv:8080/live/user/pass/4521.ts")).toBe("4521");
    expect(xtreamStreamId("http://p.tv/user/pass/4521")).toBe("4521");
    expect(xtreamStreamId("http://p.tv/user/pass/4521.m3u8?t=1#x")).toBe("4521");
    expect(xtreamStreamId("http://p.tv/channels/12.m3u8")).toBeUndefined();
    expect(xtreamStreamId("http://p.tv/a/b/index.m3u8")).toBeUndefined();
    expect(xtreamStreamId("http://p.tv/a//12.ts")).toBeUndefined();
    expect(xtreamStreamId("http://p.tv/a/b/12.ts/")).toBeUndefined();
    expect(xtreamStreamId("http://p.tv/a/b/?id=12")).toBeUndefined();
    expect(xtreamStreamId("not a url")).toBeUndefined();
  });

  it("stay the same when the password or a token changes, or channels move", () => {
    const before = channelKeys([
      channel("News", "http://p.tv/live/u/old/10.ts"),
      channel("Sport", "http://cdn/sport.m3u8?token=1"),
    ]);
    const after = channelKeys([
      channel("Added", "http://p.tv/live/u/new/9.ts"),
      channel("Sport", "http://cdn/sport.m3u8?token=2"),
      channel("News renamed", "http://p.tv/live/u/new/10.ts"),
    ]);
    expect(new Set(after.slice(1))).toEqual(new Set(before));
  });

  it("tell apart channels that share a key by group, then by count", () => {
    expect(
      channelKeys([
        channel("HBO", "http://a/1.ts", { group: "Movies" }),
        channel("HBO", "http://a/2.ts", { group: "US" }),
        channel("HBO", "http://a/3.ts", { group: "US" }),
        channel("HBO", "http://a/4.ts"),
      ]),
    ).toEqual(["n:hbo", "n:hbo|US", "n:hbo|US#2", "n:hbo|"]);
  });
});
