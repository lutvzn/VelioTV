import { describe, expect, it } from "vitest";
import { catalog } from "../../scripts/test-streams/catalog.mjs";
import { m3u } from "../../scripts/test-streams/playlist.mjs";
import { REQUIRED_REFERER, REQUIRED_USER_AGENT } from "../../scripts/test-streams/streams.mjs";
import { M3uParser, parseAttributes, parseM3u } from "./m3u";
import type { PlaylistChannel } from "./types";

const BASE = "http://test.local:8090";

describe("parseAttributes", () => {
  it("reads quoted and unquoted values and the title", () => {
    expect(parseAttributes('-1 tvg-id="a.b" tvg-chno=7 group-title="News, Weather",Channel, One')).toEqual({
      attributes: { "tvg-id": "a.b", "tvg-chno": "7", "group-title": "News, Weather" },
      title: "Channel, One",
    });
  });

  it("copes with a stray quote inside a value", () => {
    const { attributes, title } = parseAttributes('-1 tvg-name="The "Big" One" tvg-id="x",The "Big" One');
    expect(attributes["tvg-id"]).toBe("x");
    expect(title).toBe('The "Big" One');
  });

  it("reads a title with no attributes", () => {
    expect(parseAttributes("-1,Plain")).toEqual({ attributes: {}, title: "Plain" });
  });
});

describe("M3uParser", () => {
  it("reads headers from #EXTVLCOPT, #EXTHTTP and the URL", () => {
    const { channels } = parseM3u(
      [
        "#EXTM3U",
        "#EXTINF:-1,A",
        "#EXTVLCOPT:http-referrer=http://ref/",
        "http://a/1.ts",
        '#EXTINF:-1 group-title="G",B',
        '#EXTHTTP:{"User-Agent":"Box/1"}',
        "http://a/2.ts",
        "#EXTINF:-1,C",
        "http://a/3.ts|User-Agent=Kodi%2F20&Referer=http://r/",
      ].join("\n"),
    );
    expect(channels.map(c => c.headers)).toEqual([
      { referer: "http://ref/" },
      { userAgent: "Box/1" },
      { userAgent: "Kodi/20", referer: "http://r/" },
    ]);
    expect(channels[2].url).toBe("http://a/3.ts");
  });

  it("handles CRLF, a byte order mark, #EXTGRP and plain URLs", () => {
    const { channels, guideUrls } = parseM3u(
      '﻿#EXTM3U url-tvg="http://g/1.xml, http://g/2.xml.gz"\r\n#EXTINF:-1,A\r\n#EXTGRP:Films\r\nhttp://a/1.ts\r\nhttp://a/2.ts\r\n',
    );
    expect(guideUrls).toEqual(["http://g/1.xml", "http://g/2.xml.gz"]);
    expect(channels).toEqual([
      { index: 0, name: "A", url: "http://a/1.ts", group: "Films" },
      { index: 1, name: "http://a/2.ts", url: "http://a/2.ts" },
    ]);
  });

  it("gives the same channels however the text is split", () => {
    const text = m3u({ base: BASE, channels: catalog(60).channels, guideUrl: `${BASE}/guide.xml` });
    const whole = parseM3u(text).channels;
    const pieces: PlaylistChannel[] = [];
    const parser = new M3uParser(channel => pieces.push(channel));
    for (let i = 0; i < text.length; i += 7) parser.push(text.slice(i, i + 7));
    parser.end();
    expect(pieces).toEqual(whole);
  });

  it("reads the test server's playlist", () => {
    const { channels: expected } = catalog(1000);
    const text = m3u({ base: BASE, channels: expected, guideUrl: `${BASE}/guide.xml.gz` });
    const { channels, guideUrls } = parseM3u(text);
    expect(guideUrls).toEqual([`${BASE}/guide.xml.gz`]);
    expect(channels).toHaveLength(expected.length);
    for (const [i, channel] of channels.entries()) {
      const want = expected[i];
      expect(channel.name).toBe(want.name);
      expect(channel.guideId).toBe(want.guideId ?? undefined);
      expect(channel.number).toBe(want.number);
      expect(channel.group).toBe(want.group);
      expect(channel.logo).toBe(want.logo ? `${BASE}${want.logo}` : undefined);
      expect(channel.catchup?.days).toBe(want.archiveDays || undefined);
      const headers =
        want.header === "referer"
          ? { referer: REQUIRED_REFERER }
          : want.header === "user-agent"
            ? { userAgent: REQUIRED_USER_AGENT }
            : undefined;
      expect(channel.headers).toEqual(headers);
    }
    // The awkward names come through whole.
    expect(channels[996].name).toMatch(/^Smith, Jones & Sons /);
    expect(channels[990].name).toMatch(/^Café Ünïcode 日本 /);
    expect(channels[982].name).toMatch(/^The "Quoted" /);
  });
});
