// Seeking with the remote (PLAN.md, Phase 6, step 1): each press of Left or
// Right (or Rewind or Fast forward) moves a target, which shows on the bar,
// and the player jumps there once the presses stop. Held down, or pressed
// again and again, the steps grow, so an hour is a few seconds away.

import { createSignal } from "solid-js";

/** How long after the last press the jump happens. */
export const SEEK_DELAY_MS = 700;

/** The step for the `presses`-th press in a row in one direction. */
export const seekStep = (presses: number) => (presses <= 3 ? 30_000 : presses <= 8 ? 60_000 : 300_000);

export interface SeekerOptions {
  /** Where playback is now, in the page's own terms (ms into a film, or a time of day). */
  position: () => number;
  /** The earliest and latest places to jump to. */
  min: () => number;
  max: () => number;
  /** Makes the jump. */
  commit: (target: number) => void;
  delayMs?: number;
}

export const createSeeker = (options: SeekerOptions) => {
  const [target, setTarget] = createSignal<number>();
  let presses = 0;
  let direction = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    clearTimeout(timer);
    timer = undefined;
    const at = target();
    presses = 0;
    direction = 0;
    setTarget(undefined);
    if (at !== undefined) options.commit(at);
  };

  return {
    /** Where the presses so far would jump to; undefined when not seeking. */
    target,
    /** One press: `step` is +1 forward or -1 back; `first` the press count to start from, for bigger first steps. */
    press: (step: 1 | -1, first = 1) => {
      if (step !== direction) presses = first - 1;
      direction = step;
      presses++;
      const from = target() ?? options.position();
      const next = Math.max(options.min(), Math.min(options.max(), from + step * seekStep(presses)));
      setTarget(next);
      clearTimeout(timer);
      timer = setTimeout(finish, options.delayMs ?? SEEK_DELAY_MS);
    },
    /** Jumps now, without waiting. */
    finish,
    /** Forgets the presses without jumping. */
    cancel: () => {
      clearTimeout(timer);
      timer = undefined;
      presses = 0;
      direction = 0;
      setTarget(undefined);
    },
  };
};

export type Seeker = ReturnType<typeof createSeeker>;
