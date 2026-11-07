// Picking a channel by typing its number, as in the TV guide: digits gather
// until OK or a pause, then go to `onNumber`. A number it doesn't take shows
// as missing for a moment.

import { createSignal } from "solid-js";
import { MAX_DIGITS, NUMBER_DELAY_MS } from "./zapper";

export const MISSING_MS = 2000;

export const createNumberEntry = (options: {
  /** Acts on a number typed; false when no channel has it. */
  onNumber: (number: number) => boolean;
  delayMs?: number;
}) => {
  const [digits, setDigits] = createSignal("");
  const [missing, setMissing] = createSignal<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let missingTimer: ReturnType<typeof setTimeout> | undefined;

  const clearDigits = () => {
    clearTimeout(timer);
    timer = undefined;
    setDigits("");
  };
  const clearMissing = () => {
    clearTimeout(missingTimer);
    setMissing(undefined);
  };
  const enter = () => {
    const typed = digits();
    clearDigits();
    if (!typed || options.onNumber(Number(typed))) return;
    setMissing(typed);
    clearTimeout(missingTimer);
    missingTimer = setTimeout(clearMissing, MISSING_MS);
  };

  return {
    digits,
    missing,
    /** Whether anything shows: digits typed, or a number not found. */
    active: () => digits() !== "" || missing() !== undefined,
    digit: (value: number) => {
      clearMissing();
      setDigits((digits() + String(value)).slice(-MAX_DIGITS));
      clearTimeout(timer);
      timer = setTimeout(enter, options.delayMs ?? NUMBER_DELAY_MS);
    },
    enter,
    clear: () => {
      clearDigits();
      clearMissing();
    },
    dispose: () => {
      clearTimeout(timer);
      clearTimeout(missingTimer);
    },
  };
};
