// Reading the app out with the TV's voice guide (PLAN.md, Phase 8, step 5).
// The app draws on a canvas, which a screen reader can't see, so what to
// read goes into a hidden live region: Samsung's voice guide reads it, in
// the voice and speed the user set, and doesn't talk over it. That works
// only while the voice guide is on (the device says when), and so does the
// Web Speech API, so the app doesn't speak by itself.
//
// What is read: when the focus moves, the focused node's `announce`, or else
// its text; pages that move a cursor of their own, such as the guide, say
// what's under it with sayWhileFocused(). Only the last thing asked for in
// a short while is read, so moving fast reads where the focus stops.

import { focusPath } from "@solidtv/solid/primitives";
import { createEffect, createRoot, createSignal, on, untrack } from "solid-js";
import { language } from "./translate";

/** What to read: a phrase, or phrases read one after the other. */
export type Spoken = string | readonly (string | undefined | false)[] | undefined;

const WAIT_MS = 250;
const REGION_ID = "voice-guide";

/** Whether the TV's voice guide is on. */
const [voiceGuideOn, setVoiceGuideOn] = createSignal(false);
export { setVoiceGuideOn, voiceGuideOn };

const phrases = (spoken: Spoken) =>
  (typeof spoken === "string" ? [spoken] : (spoken ?? []))
    .filter((part): part is string => typeof part === "string")
    .map(part => part.trim())
    .filter(Boolean);

let region: HTMLElement | undefined;
const theRegion = () => {
  if (region) return region;
  region = document.createElement("div");
  region.id = REGION_ID;
  region.setAttribute("aria-live", "assertive");
  region.setAttribute("aria-atomic", "true");
  // Out of sight, behind the canvas, but not display: none, which isn't read.
  region.setAttribute(
    "style",
    "position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none",
  );
  document.body.appendChild(region);
  return region;
};

let timer: ReturnType<typeof setTimeout> | undefined;
let last = "";

/** The last text put in the region, for tests and probes. */
export const lastSaid = () => last;

/** Reads `spoken` out, unless something else is asked for within 250 ms. */
export const say = (spoken: Spoken) => {
  if (!untrack(voiceGuideOn)) return;
  const text = phrases(spoken).join(". ");
  if (!text) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const target = theRegion();
    target.setAttribute("lang", untrack(language));
    // Emptied first, so the same text again is read again.
    target.textContent = "";
    setTimeout(() => {
      target.textContent = text;
      last = text;
    }, 50);
  }, WAIT_MS);
};

interface Readable {
  _type?: string;
  children?: readonly Readable[];
  hidden?: boolean;
  alpha?: number;
  announce?: unknown;
  getText?: () => string;
}

/** The text drawn in a node, in tree order, leaving out what's hidden. */
export const textOf = (node: Readable, out: string[] = []): string[] => {
  if (node.hidden || node.alpha === 0) return out;
  if (node._type === "textNode") {
    const text = node.getText?.().trim();
    if (text) out.push(text);
    return out;
  }
  for (const child of node.children ?? []) textOf(child, out);
  return out;
};

/**
 * What to read for a focused node: its `announce` if it has one (an empty
 * one for a node whose page says what's under its own cursor), or else
 * its text.
 */
export const announcementOf = (node: Readable): string[] => {
  const { announce } = node;
  if (typeof announce === "string") return phrases(announce);
  if (Array.isArray(announce)) return phrases(announce.filter(part => typeof part === "string"));
  return textOf(node);
};

/**
 * Reads what `text` gives while `focused` is true: all of it when the focus
 * comes, then what changed. For pages with a cursor of their own, which
 * give their focused node `announce=""` so the focus doesn't read all of
 * the page. Put the context first, such as the channel before its
 * programme: the phrases at the start that are the same as the last time
 * aren't read again, so moving along a channel reads only the programmes.
 */
export const sayWhileFocused = (focused: () => boolean, text: () => Spoken) => {
  let before: string[] = [];
  createEffect(
    on(
      () => (voiceGuideOn() && focused() ? phrases(text()) : undefined),
      now => {
        if (!now) {
          before = [];
          return;
        }
        let same = 0;
        while (same < now.length && now[same] === before[same]) same++;
        before = now;
        if (same < now.length) say(now.slice(same));
      },
    ),
  );
};

/** Reads the focused node whenever the focus moves. Call once, in the app's frame. */
export const readFocus = () =>
  createEffect(
    on(
      focusPath,
      path => {
        const focused: Readable | undefined = path[0];
        if (focused) say(announcementOf(focused));
      },
      { defer: true },
    ),
  );

/** Follows the device's voice guide setting for the life of the app. */
export const followVoiceGuide = (watch: (changed: (on: boolean) => void) => void) =>
  createRoot(() => {
    watch(setVoiceGuideOn);
    createEffect(on(voiceGuideOn, isOn => isOn && say(announcementOfFocus()), { defer: true }));
  });

const announcementOfFocus = () => {
  const focused: Readable | undefined = untrack(focusPath)[0];
  return focused ? announcementOf(focused) : undefined;
};
