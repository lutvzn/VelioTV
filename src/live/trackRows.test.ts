import { describe, expect, it } from "vitest";
import { firstChoice, nextChoice, trackRows } from "./trackRows";

const text = {
  audio: "Audio",
  subtitles: "Subtitles",
  off: "Off",
  noAudio: "No audio",
  noSubtitles: "No subtitles",
  unnamed: (number: number) => `Track ${number}`,
};

describe("the track panel's rows", () => {
  it("lists audio, then subtitles with Off, naming each track", () => {
    const rows = trackRows(
      [
        { id: "1", kind: "audio", language: "eng", selected: false },
        { id: "2", kind: "audio", language: "deu", selected: true },
        { id: "5", kind: "audio", label: "Director", selected: false },
        { id: "6", kind: "audio", selected: false },
        { id: "3", kind: "text", language: "en", selected: false },
        { id: "4", kind: "text", language: "en", selected: false },
      ],
      text,
    );
    expect(
      rows.map(row => (row.type === "choice" ? `${row.text}${row.selected ? " *" : ""}` : `[${row.text}]`)),
    ).toEqual([
      "[Audio]",
      "English",
      "German *",
      "Director",
      "Track 4",
      "[Subtitles]",
      "Off *",
      "English 1",
      "English 2",
    ]);
    expect(firstChoice(rows)).toBe(2);
  });

  it("says when there's nothing to choose, and skips headings and notes", () => {
    const rows = trackRows([], text);
    expect(rows.map(row => row.text)).toEqual(["Audio", "No audio", "Subtitles", "Off", "No subtitles"]);
    expect(firstChoice(rows)).toBe(3);
    expect(nextChoice(rows, 3, 1)).toBe(3);
    expect(nextChoice(rows, 3, -1)).toBe(3);

    const some = trackRows([{ id: "1", kind: "audio", language: "en", selected: true }], text);
    // Audio, English, Subtitles, Off, No subtitles
    expect(nextChoice(some, 1, 1)).toBe(3);
    expect(nextChoice(some, 3, 1)).toBe(1);
    expect(nextChoice(some, 1, -1)).toBe(3);
  });
});
