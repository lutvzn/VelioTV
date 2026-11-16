// Subtitles from an add-on's file (PLAN.md, "Stremio add-ons", step 6): the
// one chosen is downloaded and read (src/stremio/subtitleFile.ts), and its
// text follows the player's position. It looks again when the text is next
// due to change, and at least twice a second, so a seek or a pause shows
// within half a second.

import { createSignal } from "solid-js";
import { cuesAt, nextChange, readSubtitleFile, type Cue } from "../stremio/subtitleFile";
import { decodeSubtitles, withoutSoundText } from "../stremio/subtitleText";
import { getBytes } from "../stremio/addon";

/** The longest wait between looks. */
const MAX_WAIT_MS = 500;
/** The shortest, so a run of tiny cues doesn't spin. */
const MIN_WAIT_MS = 40;

export interface ExternalSubtitlesOptions {
  /** Where the film is, in milliseconds. */
  position: () => number;
  fetch?: typeof fetch;
}

export const createExternalSubtitles = (options: ExternalSubtitlesOptions) => {
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const [text, setText] = createSignal<string>();
  const [chosen, setChosen] = createSignal<string>();
  const [problem, setProblem] = createSignal<string>();
  let cues: Cue[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = 0;

  const look = () => {
    clearTimeout(timer);
    if (cues.length === 0) return;
    const at = options.position();
    setText(cuesAt(cues, at) || undefined);
    const wait = Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, nextChange(cues, at) - at));
    timer = setTimeout(look, wait);
  };

  const off = () => {
    asked++;
    clearTimeout(timer);
    cues = [];
    setText(undefined);
    setChosen(undefined);
    setProblem(undefined);
  };

  return {
    /** The text to draw now, if any. */
    text,
    /** The id of the file shown, if one is. */
    chosen,
    /** Why the file chosen couldn't be read. */
    problem,
    /**
     * Shows the file `id` at `url`; resolves once it's read, or failed to be.
     * Its language helps read its characters; `hideSoundText` takes out
     * "[music]" and the like.
     */
    show: async (id: string, url: string, file: { language?: string; hideSoundText?: boolean } = {}) => {
      off();
      const mine = asked;
      setChosen(id);
      try {
        const all = readSubtitleFile(decodeSubtitles(await getBytes(url, fetcher), file.language));
        const read = file.hideSoundText
          ? all.map(cue => ({ ...cue, text: withoutSoundText(cue.text) })).filter(cue => cue.text)
          : all;
        if (mine !== asked) return;
        if (read.length === 0) throw new Error("It has no subtitles in it");
        cues = read;
        look();
      } catch (error) {
        if (mine !== asked) return;
        console.warn("Couldn't read the subtitles:", error);
        setProblem(error instanceof Error ? error.message : String(error));
      }
    },
    off,
  };
};

export type ExternalSubtitles = ReturnType<typeof createExternalSubtitles>;
