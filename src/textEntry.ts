// Typing with the TV's own on-screen keyboard. The app draws on a canvas,
// which takes no text, so editing puts a real <input> over the field being
// edited and focuses it, which opens the keyboard on Samsung and LG TVs (and
// takes typing in a desktop browser). The keyboard's own keys, such as
// Done, finish the edit.
//
// While the input has focus, its key events stop there, so that the app's
// focus manager, which listens on the document, doesn't act on them.

import type { Rect } from "./videoWindow";

const APP_WIDTH = 1920;
const KEY = {
  enter: 13,
  escape: 27,
  tizenBack: 10009,
  // Samsung's keyboard sends these for its Done and Cancel keys.
  imeDone: 65376,
  imeCancel: 65385,
  // LG's Back.
  webosBack: 461,
};
const FINISH_KEYS = new Set(Object.values(KEY));

export interface TextEntry {
  /** Where the field is, in app pixels (1920 × 1080). */
  rect: Rect;
  value: string;
  /** The keyboard layout to ask for. */
  inputMode?: "text" | "url";
  fontSize?: number;
  /** Called with the text as typed, when the edit ends. */
  onDone: (value: string) => void;
}

let closeOpen: (() => void) | undefined;

// The key-up of the key that ends an edit would otherwise reach the app,
// which never saw it go down.
const swallowKeyUp = (keyCode: number) => {
  const swallow = (event: KeyboardEvent) => {
    if (event.keyCode !== keyCode) return;
    event.stopPropagation();
    event.preventDefault();
    window.removeEventListener("keyup", swallow, true);
  };
  window.addEventListener("keyup", swallow, true);
  setTimeout(() => window.removeEventListener("keyup", swallow, true), 1000);
};

/** Opens the keyboard to edit a value. Only one edit is open at a time. */
export const editText = (entry: TextEntry) => {
  closeOpen?.();
  const canvas = document.querySelector("canvas");
  const box = canvas?.getBoundingClientRect();
  const scale = (box?.width ?? window.innerWidth) / APP_WIDTH;
  const px = (value: number) => `${Math.round(value * scale)}px`;

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = entry.inputMode ?? "text";
  input.value = entry.value;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  Object.assign(input.style, {
    position: "fixed",
    left: `${(box?.left ?? 0) + entry.rect.x * scale}px`,
    top: `${(box?.top ?? 0) + entry.rect.y * scale}px`,
    width: px(entry.rect.width),
    height: px(entry.rect.height),
    boxSizing: "border-box",
    padding: `0 ${px(20)}`,
    border: `${px(3)} solid #5b95ff`,
    borderRadius: px(10),
    outline: "none",
    background: "#0b1d33",
    color: "#ffffff",
    font: `${px(entry.fontSize ?? 34)} Roboto, sans-serif`,
    zIndex: "10",
  });

  let open = true;
  const finish = () => {
    if (!open) return;
    open = false;
    closeOpen = undefined;
    const { value } = input;
    input.removeEventListener("blur", finish);
    input.remove();
    entry.onDone(value);
  };
  closeOpen = finish;

  input.addEventListener("keydown", event => {
    event.stopPropagation();
    if (!FINISH_KEYS.has(event.keyCode)) return;
    event.preventDefault();
    swallowKeyUp(event.keyCode);
    finish();
  });
  input.addEventListener("keyup", event => event.stopPropagation());
  input.addEventListener("blur", finish);

  document.body.appendChild(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
};
