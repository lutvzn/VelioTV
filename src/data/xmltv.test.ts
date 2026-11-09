import { describe, expect, it } from "vitest";
import { catalog, guideChannels, guideWindow, programmes } from "../../scripts/test-streams/catalog.mjs";
import { xmltv } from "../../scripts/test-streams/playlist.mjs";
import type { GuideChannel, Programme } from "./types";
import { decodeXml, parseXmltvTime, XmltvParser, type XmltvHandlers } from "./xmltv";

const parse = (text: string, chunk = text.length, options: Partial<XmltvHandlers> = {}) => {
  const channels: GuideChannel[] = [];
  const list: Programme[] = [];
  const parser = new XmltvParser({
    ...options,
    onChannel: c => channels.push(c),
    onProgramme: p => list.push(p),
  });
  for (let i = 0; i < text.length; i += chunk) parser.push(text.slice(i, i + chunk));
  return { channels, programmes: list, parser };
};

describe("parseXmltvTime", () => {
  it("reads time zones", () => {
    expect(parseXmltvTime("20261102143000 +0000")).toBe(Date.UTC(2026, 10, 2, 14, 30));
    expect(parseXmltvTime("20261102143000 +0100")).toBe(Date.UTC(2026, 10, 2, 13, 30));
    expect(parseXmltvTime("20261102143000 -0500")).toBe(Date.UTC(2026, 10, 2, 19, 30));
    expect(parseXmltvTime("20261102200000 +0530")).toBe(Date.UTC(2026, 10, 2, 14, 30));
  });

  it("allows left-out parts and a default time zone", () => {
    expect(parseXmltvTime("202611021430")).toBe(Date.UTC(2026, 10, 2, 14, 30));
    expect(parseXmltvTime("20261102")).toBe(Date.UTC(2026, 10, 2));
    expect(parseXmltvTime("20261102143000", 60)).toBe(Date.UTC(2026, 10, 2, 13, 30));
    expect(parseXmltvTime(" 20261102143000 +0100 ")).toBe(Date.UTC(2026, 10, 2, 13, 30));
    expect(parseXmltvTime("20261102143000 GMT")).toBe(Date.UTC(2026, 10, 2, 14, 30));
    expect(parseXmltvTime("20261102143000Z", 60)).toBe(Date.UTC(2026, 10, 2, 14, 30));
    expect(parseXmltvTime("nonsense")).toBeUndefined();
    expect(parseXmltvTime(undefined)).toBeUndefined();
  });
});

describe("decodeXml", () => {
  it("decodes entities and CDATA", () => {
    expect(decodeXml("Tom &amp; Jerry &#233;&#x1F600; &lt;b&gt; &bogus;")).toBe(
      "Tom & Jerry é😀 <b> &bogus;",
    );
    expect(decodeXml("<![CDATA[Fish & <Chips>]]>")).toBe("Fish & <Chips>");
  });
});

describe("XmltvParser", () => {
  const sample = `<?xml version="1.0"?>
<tv>
  <channel id="one.test">
    <display-name lang="en">One &amp; Only</display-name>
    <icon src="http://logo/1.png"/>
  </channel>
  <channel id='two.test'><display-name>Two</display-name></channel>
  <programme start="20261102120000 +0000" stop="20261102130000 +0000" channel="one.test">
    <title lang="en">News</title>
    <title lang="fr">Infos</title>
    <sub-title>Midday</sub-title>
    <desc><![CDATA[Today's <news>.]]></desc>
    <category>News</category><category>Current affairs</category>
    <episode-num system="xmltv_ns">1.4.0/1</episode-num>
    <icon src="http://img/1.jpg" />
    <new/>
  </programme>
  <programme start="20261102130000 +0000" channel="one.test"><title>No stop</title></programme>
  <programme start="20261102130000 +0000" channel="two.test"/>
  <programme channel="two.test"><title>No start</title></programme>
</tv>`;

  it("reads channels and programmes", () => {
    const { channels, programmes: list, parser } = parse(sample);
    expect(channels).toEqual([
      { id: "one.test", name: "One & Only", icon: "http://logo/1.png" },
      { id: "two.test", name: "Two" },
    ]);
    expect(list).toEqual([
      {
        channel: "one.test",
        start: Date.UTC(2026, 10, 2, 12),
        stop: Date.UTC(2026, 10, 2, 13),
        title: "News",
        subTitle: "Midday",
        description: "Today's <news>.",
        categories: ["News", "Current affairs"],
        episode: "S02E05",
        icon: "http://img/1.jpg",
        isNew: true,
      },
      { channel: "one.test", start: Date.UTC(2026, 10, 2, 13), title: "No stop" },
    ]);
    // The self-closing programme has no title, and the last no start.
    expect(parser.invalid).toBe(2);
  });

  it("reads as Date.UTC() would, past the ends of months and days", () => {
    expect(parseXmltvTime("20261232250000 +0000")).toBe(Date.UTC(2026, 11, 32, 25));
    expect(parseXmltvTime("20260100000000 +0000")).toBe(Date.UTC(2026, 0, 0));
    expect(parseXmltvTime("20261302000000 +0000")).toBe(Date.UTC(2026, 12, 2));
    expect(parseXmltvTime("00990101000000 +0000")).toBe(Date.UTC(99, 0, 1));
    expect(parseXmltvTime("18000301000000 -1200")).toBe(Date.UTC(1800, 2, 1, 12));
  });

  it("leaves out the channels it's told to, unread", () => {
    const seen: string[] = [];
    const { programmes: list, parser } = parse(sample, 17, {
      channelOf: id => {
        seen.push(id);
        return id === "one.test" ? "ONE" : undefined;
      },
    });
    expect(list.map(p => [p.channel, p.title])).toEqual([
      ["ONE", "News"],
      ["ONE", "No stop"],
    ]);
    expect(parser.unwanted).toBe(2);
    expect(parser.invalid).toBe(0);
    // Asked once for each run of a channel's programmes.
    expect(seen).toEqual(["one.test", "two.test"]);
  });

  it("can leave out categories, icons and new flags", () => {
    const [first] = parse(sample, sample.length, { skipExtras: true }).programmes;
    expect(first).toEqual({
      channel: "one.test",
      start: Date.UTC(2026, 10, 2, 12),
      stop: Date.UTC(2026, 10, 2, 13),
      title: "News",
      subTitle: "Midday",
      description: "Today's <news>.",
      episode: "S02E05",
    });
  });

  it("reads what is nested, or in CDATA, as a search by name would", () => {
    const text = `<programme start="20261102120000 +0000" channel="c">
      <desc><![CDATA[<title>In CDATA</title>]]></desc><title>Later</title>
      <rating><icon src="r.png"/></rating><icon src="own.png"/>
      <episode-num system="onscreen">S01E01<episode-num system="onscreen">S9</episode-num></episode-num>
      <category>A</category><icon src="unclosed.png">x</programme>`;
    expect(parse(text).programmes).toEqual([
      {
        channel: "c",
        start: Date.UTC(2026, 10, 2, 12),
        title: "In CDATA",
        description: "<title>In CDATA</title>",
        icon: "r.png",
        episode: 'S01E01<episode-num system="onscreen">S9',
        categories: ["A"],
      },
    ]);
  });

  it("reads what real guides hold", () => {
    const text = `<tv>
<programme start="20261102010000 +0000" stop="20261102020000 +0000" channel="Odd.Channel">
  <title lang="en">Tom &amp; Jerry &lt;3 &#233;&#xE9;&#X1F600; &nope; &#0; &#1114112; &amp</title>
  <sub-title>  <![CDATA[Raw <b>bold</b> & "quoted"]]>  </sub-title>
  <desc>Line one
line two\tand a tab</desc>
  <episode-num system="xmltv_ns">1.4.0/1</episode-num>
</programme>
<programme start="20261102020000 +0030" channel="Odd.Channel"><title>Half an hour earlier</title></programme>
<programme start="20261102030000" channel="Odd.Channel"><title>No zone</title>
  <episode-num system="xmltv_ns">.3.</episode-num><episode-num system="onscreen">S9 E9</episode-num></programme>
<programme start="20261102050000Z" channel="Odd.Channel"><title>  Zulu, unicode: Łódź ☃ \uFEFF</title>
  <episode-num system="xmltv_ns"> 2 . 0 </episode-num></programme>
<programme start="20261102060000 -0230" channel="Odd.Channel"><title/></programme>
<programme start="20261102070000" channel="Odd.Channel"><title>  </title></programme>
<programme start="2026" channel="Odd.Channel"><title>Bad start</title></programme>
<programme start='20261102080000 GMT' channel='odd.channel'><title>Single quotes</title><new/></programme>
</tv>`;
    for (const chunk of [text.length, 7, 64]) {
      const { programmes: list, parser } = parse(text, chunk, { skipExtras: true });
      expect(list.map(p => [p.channel, p.start, p.title, p.episode])).toEqual([
        [
          "Odd.Channel",
          Date.UTC(2026, 10, 2, 1),
          "Tom & Jerry <3 éé😀 &nope; &#0; &#1114112; &amp",
          "S02E05",
        ],
        ["Odd.Channel", Date.UTC(2026, 10, 2, 1, 30), "Half an hour earlier", undefined],
        ["Odd.Channel", Date.UTC(2026, 10, 2, 3), "No zone", "S9 E9"],
        ["Odd.Channel", Date.UTC(2026, 10, 2, 5), "Zulu, unicode: Łódź ☃", "S03E01"],
        ["odd.channel", Date.UTC(2026, 10, 2, 8), "Single quotes", undefined],
      ]);
      expect(list[0]).toMatchObject({
        subTitle: 'Raw <b>bold</b> & "quoted"',
        description: "Line one\nline two\tand a tab",
      });
      expect(list[4].isNew).toBeUndefined();
      // The empty title, the blank one and the bad start.
      expect(parser.invalid).toBe(3);
    }
  });

  it("gives the same result however the text is split", () => {
    for (const chunk of [1, 3, 17, 100])
      expect(parse(sample, chunk).programmes).toEqual(parse(sample).programmes);
  });

  it("reads the test server's guide", () => {
    const { channels } = catalog(50);
    const window = guideWindow(3);
    const text = [...xmltv({ base: "http://test.local", channels, window })].join("");
    const result = parse(text, 65_536);
    const listed = guideChannels(channels);
    expect(result.channels.map(c => c.id)).toEqual(listed.map(c => c.guideId));

    const expected = listed.flatMap(channel =>
      [...programmes(channel, window)].map(p => ({
        channel: channel.guideId,
        start: p.start,
        stop: p.stop,
        title: p.title,
        description: p.description,
        episode: p.season
          ? `S${String(p.season).padStart(2, "0")}E${String(p.episode).padStart(2, "0")}`
          : undefined,
      })),
    );
    expect(result.programmes).toHaveLength(expected.length);
    expect(
      result.programmes.map(p => ({
        channel: p.channel,
        start: p.start,
        stop: p.stop,
        title: p.title,
        description: p.description,
        episode: p.episode,
      })),
    ).toEqual(expected);
  });
});
