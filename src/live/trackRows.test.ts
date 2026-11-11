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

  it("offers add-on files after the stream's own, and a file shown hides them", () => {
    const rows = trackRows(
      [
        { id: "1", kind: "audio", language: "eng", selected: true },
        { id: "3", kind: "text", language: "en", selected: true },
      ],
      text,
      [{ id: "a/srt", text: "English · Test", selected: true }],
    );
    expect(
      rows.map(row =>
        row.type === "heading" || row.type === "note"
          ? `[${row.text}]`
          : `${row.text}${row.selected ? " *" : ""}`,
      ),
    ).toEqual(["[Audio]", "English *", "[Subtitles]", "Off", "English", "English · Test *"]);
    expect(nextChoice(rows, 4, 1)).toBe(5);
    // Files alone: no "No subtitles" note.
    const only = trackRows([], text, [{ id: "a/vtt", text: "Portuguese · Test", selected: false }]);
    expect(only.map(row => row.text)).toEqual(["Audio", "No audio", "Subtitles", "Off", "Portuguese · Test"]);
    expect(only[3]).toMatchObject({ selected: true });
  });
});
