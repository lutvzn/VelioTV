import { describe, expect, it } from "vitest";
import { cuesAt, decodeSubtitles, nextChange, readSubtitleFile } from "./subtitleFile";

const SRT = `﻿1
00:00:01,000 --> 00:00:02,500
<i>Hello</i> &amp; welcome

2
00:00:02,000 --> 00:00:04,000
{\\an8}On top

3
00:00:10,000 --> 00:00:09,000
Backwards, skipped

4
01:00:00,250 --> 01:00:01,000
Line one
Line two
`;

const VTT = `WEBVTT

NOTE made-up

intro
00:01.000 --> 00:02.000 align:start position:10%
<v Someone>Spoken</v>

00:00:03.5 --> 00:00:04.000
Short fraction
`;

describe("a subtitle file", () => {
  it("reads SRT, dropping tags and bad cues", () => {
    expect(readSubtitleFile(SRT)).toEqual([
      { startMs: 1000, endMs: 2500, text: "Hello & welcome" },
      { startMs: 2000, endMs: 4000, text: "On top" },
      { startMs: 3_600_250, endMs: 3_601_000, text: "Line one\nLine two" },
    ]);
  });

  it("reads WebVTT, with settings after the times", () => {
    expect(readSubtitleFile(VTT.replace(/\n/g, "\r\n"))).toEqual([
      { startMs: 1000, endMs: 2000, text: "Spoken" },
      { startMs: 3500, endMs: 4000, text: "Short fraction" },
    ]);
  });

  it("shows every cue on at a time, and says when that changes", () => {
    const cues = readSubtitleFile(SRT);
    expect(cuesAt(cues, 500)).toBe("");
    expect(nextChange(cues, 500)).toBe(1000);
    expect(cuesAt(cues, 2200)).toBe("Hello & welcome\nOn top");
    expect(nextChange(cues, 2200)).toBe(2500);
    expect(cuesAt(cues, 3000)).toBe("On top");
    expect(cuesAt(cues, 4000)).toBe("");
    expect(nextChange(cues, 4000)).toBe(3_600_250);
    expect(nextChange(cues, 3_601_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("is read as Windows-1252 when it isn't UTF-8", () => {
    expect(decodeSubtitles(new Uint8Array([0x43, 0x61, 0x66, 0xe9]).buffer)).toBe("Café");
    expect(decodeSubtitles(new TextEncoder().encode("Café").buffer)).toBe("Café");
  });
});
