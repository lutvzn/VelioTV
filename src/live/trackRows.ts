// The rows of the Live TV track panel (src/pages/live/TrackPanel.tsx):
// a heading and the tracks for audio, then for subtitles, which also have
// "Off". The cursor moves only between rows that can be chosen.

import type { Track, TrackKind } from "../player/player";
import { languageName } from "../player/language";

export type TrackRow =
  | { type: "heading"; text: string }
  | { type: "note"; text: string }
  | { type: "choice"; kind: TrackKind; id: string | undefined; text: string; selected: boolean };

export interface TrackRowText {
  audio: string;
  subtitles: string;
  off: string;
  noAudio: string;
  noSubtitles: string;
  /** A track with neither a name nor a language, by its place in the list (from 1). */
  unnamed: (number: number) => string;
}

const label = (track: Track, number: number, text: TrackRowText) =>
  track.label ?? languageName(track.language) ?? text.unnamed(number);

export const trackRows = (tracks: Track[], text: TrackRowText): TrackRow[] => {
  const of = (kind: TrackKind) => tracks.filter(track => track.kind === kind);
  const choices = (list: Track[]): TrackRow[] => {
    const labels = list.map((track, at) => label(track, at + 1, text));
    // Two tracks with the same name get their numbers.
    return list.map((track, at) => ({
      type: "choice",
      kind: track.kind,
      id: track.id,
      text:
        labels.filter(one => one === labels[at]).length > 1 ? `${labels[at]} ${at + 1}` : (labels[at] ?? ""),
      selected: track.selected,
    }));
  };
  const audio = of("audio");
  const subtitles = of("text");
  return [
    { type: "heading", text: text.audio },
    ...(audio.length ? choices(audio) : [{ type: "note" as const, text: text.noAudio }]),
    { type: "heading", text: text.subtitles },
    {
      type: "choice",
      kind: "text",
      id: undefined,
      text: text.off,
      selected: !subtitles.some(track => track.selected),
    },
    ...(subtitles.length ? choices(subtitles) : [{ type: "note" as const, text: text.noSubtitles }]),
  ];
};

/** The next row from `at` that can be chosen, `step` rows on, wrapping round. */
export const nextChoice = (rows: TrackRow[], at: number, step: 1 | -1) => {
  for (let moved = 1; moved <= rows.length; moved++) {
    const index = (((at + step * moved) % rows.length) + rows.length) % rows.length;
    if (rows[index]?.type === "choice") return index;
  }
  return at;
};

/** Where the cursor starts: the audio playing, or the first choice. */
export const firstChoice = (rows: TrackRow[]) => {
  const playing = rows.findIndex(row => row.type === "choice" && row.kind === "audio" && row.selected);
  return playing >= 0 ? playing : nextChoice(rows, -1, 1);
};
