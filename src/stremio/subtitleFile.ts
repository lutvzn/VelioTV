// A subtitle file from an add-on (PLAN.md, "Stremio add-ons", step 6), read
// into timed lines that the player page draws by the film's time: SRT or
// WebVTT, told apart by their text rather than their address. Styling tags
// are dropped, as the app draws plain text.

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/** "01:02:03,456", "01:02:03.456" or "02:03.456". */
const timeOf = (value: string) => {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return undefined;
  const [, hours = "0", minutes, seconds, fraction] = match;
  return (
    ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 +
    Number(`${fraction}00`.slice(0, 3))
  );
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const plain = (lines: string[]) =>
  lines
    .join("\n")
    .replace(/<[^>]*>/g, "")
    // ASS-style tags, as some SRT files carry them: {\an8}, {\i1}.
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n");

/** Reads SRT or WebVTT; lines it can't read are skipped. The cues come in time order. */
export const readSubtitleFile = (source: string): Cue[] => {
  const blocks = source
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex(line => line.includes("-->"));
    if (at < 0) continue;
    const [from, rest = ""] = lines[at].split("-->");
    // WebVTT may put settings after the end time: "00:01.000 --> 00:02.000 align:start".
    const startMs = timeOf(from);
    const endMs = timeOf(rest.trim().split(/\s+/)[0] ?? "");
    if (startMs === undefined || endMs === undefined || endMs <= startMs) continue;
    const text = plain(lines.slice(at + 1));
    if (text) cues.push({ startMs, endMs, text });
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
  return cues.sort((a, b) => a.startMs - b.startMs);
};

/** How many cues before `ms` can still be on: overlapping cues are few. */
const OVERLAP = 10;

/** The number of cues that start at or before `ms`. */
const startedBy = (cues: readonly Cue[], ms: number) => {
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cues[middle].startMs <= ms) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** The text to show at `ms`: every cue on then, in order. */
export const cuesAt = (cues: readonly Cue[], ms: number) => {
  const started = startedBy(cues, ms);
  const on: string[] = [];
  for (let i = Math.max(0, started - OVERLAP); i < started; i++)
    if (cues[i].endMs > ms) on.push(cues[i].text);
  return on.join("\n");
};

/** When the text next changes after `ms`: a cue starting, or one on now ending. */
export const nextChange = (cues: readonly Cue[], ms: number) => {
  const started = startedBy(cues, ms);
  let next = started < cues.length ? cues[started].startMs : Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, started - OVERLAP); i < started; i++)
    if (cues[i].endMs > ms) next = Math.min(next, cues[i].endMs);
  return next;
};

/** A file's text: UTF-8, or else Windows-1252, which older subtitle files often are. */
export const decodeSubtitles = (bytes: ArrayBuffer) => {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("windows-1252").decode(bytes);
  } catch {
    return utf8;
  }
};
