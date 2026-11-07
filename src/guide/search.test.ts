import { describe, expect, it } from "vitest";
import type { Channel } from "../data/lineup";
import { fold, searchChannels } from "./search";

const channel = (index: number, name: string): Channel => ({
  source: "s",
  id: `s/${index}`,
  index,
  name,
  url: `http://a/${index}.ts`,
});

const channels = [
  channel(0, "Café TV ᴴᴰ"),
  channel(1, "Sport One"),
  channel(2, "Kino Прима"),
  channel(3, "Sport Two HD"),
];

describe("channel search", () => {
  it("folds case and accents", () => {
    expect(fold("Café Ünïcode")).toBe("cafe unicode");
    expect(fold("TV ᴴᴰ")).toBe("tv hd");
  });

  it("finds channels holding every word, in lineup order", () => {
    expect(searchChannels(channels, "sport").map(c => c.index)).toEqual([1, 3]);
    expect(searchChannels(channels, "  two   SPORT ").map(c => c.index)).toEqual([3]);
    expect(searchChannels(channels, "cafe hd").map(c => c.index)).toEqual([0]);
    expect(searchChannels(channels, "прима").map(c => c.index)).toEqual([2]);
    expect(searchChannels(channels, "news")).toEqual([]);
  });

  it("finds nothing for an empty query", () => {
    expect(searchChannels(channels, "   ")).toEqual([]);
  });
});
