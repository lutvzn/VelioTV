import { describe, expect, it } from "vitest";
import {
  heightLabel,
  heightOf,
  heightOfText,
  qualityLabel,
  sizeLabel,
  sizeOf,
  sizeOfText,
} from "./streamText";

describe("a stream's text", () => {
  it("names its picture's height", () => {
    expect(heightOfText("Film.2160p.WEB")).toBe(2160);
    expect(heightOfText("RD+ 4K HDR")).toBe(2160);
    expect(heightOfText("Film 1080p")).toBe(1080);
    expect(heightOfText("Film.720p.x264")).toBe(720);
    expect(heightOfText("Film.HDTS.x264")).toBeUndefined();
    // The name before the description.
    expect(heightOf(["Test 1080p", "Film 4K remaster"])).toBe(1080);
    expect(heightOf(["Test", "Film 4K remaster"])).toBe(2160);
  });

  it("gives the file's size", () => {
    expect(sizeOfText("👤 12 💾 1.5 GB ⚙️ Test")).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(sizeOfText("700 MB")).toBe(700 * 1024 ** 2);
    expect(sizeOfText("1,5 GB")).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(sizeOfText("Film 2019")).toBeUndefined();
    expect(sizeOf(["", "4 GB"])).toBe(4 * 1024 ** 3);
  });

  it("labels both for the picker", () => {
    expect(heightLabel(2160)).toBe("4K");
    expect(heightLabel(720)).toBe("720p");
    expect(heightLabel(undefined)).toBeUndefined();
    expect(sizeLabel(1.81 * 1024 ** 3)).toBe("1.8 GB");
    expect(sizeLabel(700 * 1024 ** 2)).toBe("700 MB");
    expect(sizeLabel(undefined)).toBeUndefined();
  });

  it("labels a source's file, its size worked out from the bitrate", () => {
    expect(qualityLabel({ height: 2160, estimatedBytes: 2.1 * 1024 ** 3 })).toBe("4K  ~2.1 GB");
    expect(qualityLabel({ height: 1080 }, " · ")).toBe("1080p");
    expect(qualityLabel({})).toBe("");
  });

  it("finds the height in an IPTV film's name or group", () => {
    expect(heightOf(["Night Train (2021) 4K", "VOD | Action"])).toBe(2160);
    expect(heightOf(["Night Train (2021)", "VOD | FHD"])).toBe(1080);
    expect(heightOf(["Night Train (2021)", "Action"])).toBeUndefined();
  });
});
