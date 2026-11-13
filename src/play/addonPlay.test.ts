import { describe, expect, it, vi } from "vitest";
import type { AddonStream } from "../stremio/addon";
import { ADDON_START_TIMEOUT_MS, chosenStreams, likeLast, streamOf } from "./addonPlay";

// The library starts the app's stores; only the add-ons are needed here (vi.mock is hoisted).
vi.mock("../library", () => ({ addons: {} }));

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
    },
    { addon: "b", addonName: "B", streams: [stream("b1", "sd")], unplayable: 0, needReferer: 0 },
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
      { addon: "a", addonName: "A", streams: [silent, stream("a1")], unplayable: 0, needReferer: 0 },
      { addon: "b", addonName: "B", streams: [stream("b1")], unplayable: 0, needReferer: 0 },
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
