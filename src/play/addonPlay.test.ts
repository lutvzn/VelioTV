import { describe, expect, it, vi } from "vitest";
import type { AddonStream } from "../stremio/addon";
import { DEFAULT_PLAY_CHOICES } from "../data/playChoices";
import { createMatcher } from "./autoPlay";
import {
  ADDON_START_TIMEOUT_MS,
  chosenStreams,
  fallbackStreams,
  likeLast,
  streamOf,
  streamText,
} from "./addonPlay";

// The library starts the app's stores; only the add-ons and choices are needed here (vi.mock is hoisted).
vi.mock("../library", async () => {
  const { DEFAULT_PLAY_CHOICES: choices } = await import("../data/playChoices");
  return {
    addons: {},
    playChoices: { choices: () => choices },
    debrid: { service: () => undefined, stateOf: () => "unknown" },
  };
});

const stream = (url: string, bingeGroup?: string): AddonStream => ({
  url,
  name: url,
  description: "",
  subtitles: [],
  ...(bingeGroup ? { bingeGroup } : {}),
});

describe("an add-on's next episode", () => {
  const found = chosenStreams([
    {
      addon: "a",
      addonName: "A",
      streams: [stream("a1", "hd"), stream("a2", "sd")],
      unplayable: 0,
      needReferer: 0,
      torrents: 0,
    },
    { addon: "b", addonName: "B", streams: [stream("b1", "sd")], unplayable: 0, needReferer: 0, torrents: 0 },
  ]);

  it("plays the same add-on's stream of the same kind", () => {
    expect(likeLast(found, { addon: "a", addonName: "A", stream: stream("old", "sd") })?.stream.url).toBe(
      "a2",
    );
  });

  it("else the same add-on's first, else the first of any", () => {
    expect(likeLast(found, { addon: "b", addonName: "B", stream: stream("old", "4k") })?.stream.url).toBe(
      "b1",
    );
    expect(likeLast(found, { addon: "c", addonName: "C", stream: stream("old") })?.stream.url).toBe("a1");
    expect(likeLast([], { addon: "a", addonName: "A", stream: stream("old") })).toBeUndefined();
  });
});

describe("an add-on's streams", () => {
  it("put those the TV may play silent last, and wait longer for each to start", () => {
    const silent: AddonStream = { ...stream("dts"), silent: true };
    const found = chosenStreams([
      {
        addon: "a",
        addonName: "A",
        streams: [silent, stream("a1")],
        unplayable: 0,
        needReferer: 0,
        torrents: 0,
      },
      { addon: "b", addonName: "B", streams: [stream("b1")], unplayable: 0, needReferer: 0, torrents: 0 },
    ]);
    expect(found.map(one => one.stream.url)).toEqual(["a1", "b1", "dts"]);
    expect(streamOf(found[0])).toEqual({
      url: "a1",
      startTimeoutMs: ADDON_START_TIMEOUT_MS,
      from: "A",
      redirects: true,
    });
  });
});

const sized = (url: string, height?: number, sizeBytes?: number): AddonStream => ({
  ...stream(url),
  ...(height ? { height } : {}),
  ...(sizeBytes ? { sizeBytes } : {}),
});
const named = (url: string, filename: string, bingeGroup = "g"): AddonStream => ({
  ...stream(url, bingeGroup),
  filename,
});

describe("the streams' order and the ones tried after", () => {
  const found = [
    {
      addon: "a",
      addonName: "A",
      streams: [sized("a720", 720), sized("a4k-small", 2160, 5), sized("a4k-big", 2160, 9), sized("a-none")],
      unplayable: 0,
      needReferer: 0,
      torrents: 0,
    },
    {
      addon: "b",
      addonName: "B",
      streams: [sized("b1080", 1080)],
      unplayable: 0,
      needReferer: 0,
      torrents: 0,
    },
  ];

  it("keeps the add-ons in the account's order, and by quality the best picture, then the biggest, first", () => {
    expect(chosenStreams(found, "addon").map(one => one.stream.url)).toEqual([
      "a720",
      "a4k-small",
      "a4k-big",
      "a-none",
      "b1080",
    ]);
    expect(chosenStreams(found, "quality").map(one => one.stream.url)).toEqual([
      "a4k-big",
      "a4k-small",
      "a720",
      "a-none",
      "b1080",
    ]);
  });

  it("tries the others auto-play would play, as many as chosen, but none with it off", () => {
    const all = chosenStreams(found, "addon");
    const first = { ...DEFAULT_PLAY_CHOICES, autoPlay: "first" as const, fallbacks: 2 };
    expect(fallbackStreams(all, all[0], first).map(one => one.stream.url)).toEqual(["a4k-small", "a4k-big"]);
    const pattern = { ...first, autoPlay: "pattern" as const, pattern: "b1080", fallbacks: 5 };
    expect(fallbackStreams(all, all[0], pattern).map(one => one.stream.url)).toEqual(["b1080"]);
    expect(fallbackStreams(all, all[0], DEFAULT_PLAY_CHOICES)).toEqual([]);
  });

  it("matches a stream by its add-on, name, description and file name", () => {
    const chosen = { addon: "a", addonName: "Alpha", stream: { ...stream("u"), filename: "Film.WEB.mkv" } };
    expect(streamText(chosen)).toBe("Alpha u Film.WEB.mkv");
    const lines = { ...chosen, stream: { ...chosen.stream, name: "[TB+] Torrentio\n720p", description: "" } };
    expect(streamText(lines)).toBe("Alpha [TB+] Torrentio 720p Film.WEB.mkv");
    expect(createMatcher({ pattern: "TB\\+.*720p", exclude: "" })(streamText(lines))).toBe(true);
  });

  it("goes on to the file named for the next episode before the binge group", () => {
    const next = chosenStreams(
      [
        {
          addon: "a",
          addonName: "A",
          streams: [named("other", "Show.S01E05.mkv"), named("wanted", "show.s01e04.MKV", "x")],
          unplayable: 0,
          needReferer: 0,
          torrents: 0,
        },
      ],
      "addon",
    );
    const last = { addon: "a", addonName: "A", stream: named("old", "Show.S01E03.mkv") };
    const episode = { id: "e4", season: 1, episode: 4, title: "", url: "" };
    expect(likeLast(next, last, episode)?.stream.url).toBe("wanted");
    expect(likeLast(next, last)?.stream.url).toBe("other");
  });
});
