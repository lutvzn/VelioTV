import { describe, expect, it } from "vitest";
import { catalog, guideChannels, guideWindow, programmes } from "../../scripts/test-streams/catalog.mjs";
import { xmltv } from "../../scripts/test-streams/playlist.mjs";
import type { GuideChannel, Programme } from "./types";
import { decodeXml, parseXmltvTime, XmltvParser } from "./xmltv";

const parse = (text: string, chunk = text.length) => {
  const channels: GuideChannel[] = [];
  const list: Programme[] = [];
  const parser = new XmltvParser({ onChannel: c => channels.push(c), onProgramme: p => list.push(p) });
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
