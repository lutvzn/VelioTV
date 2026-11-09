// Moving a cursor while Up or Down is held, faster the longer it's held, so
// the end of a long list (a few hundred groups, thousands of channels) is
// seconds away.
//
// The moves come from a timer, not the remote's repeats: a Samsung remote
// sends no repeats for a held OK (PLAN.md, Phase 5, step 1), and their pace
// isn't ours to set. So the remote's repeats are dropped until the key is
// released, and the release ends the hold: the next press starts slow again.

import { suppressKeyUntilRelease } from "@solidtv/solid/primitives";
import { createRoot, createSignal } from "solid-js";

/** How long a key is held before the cursor moves by itself. */
export const HOLD_DELAY_MS = 400;
/** Moves a second when it starts moving by itself… */
const START_SPEED = 8;
/** …doubling every this long, up to the list's top speed (Settings, "Scrolling speed"). */
const DOUBLE_MS = 2000;
const TICK_MS = 40;

/** Moves made while speeding up, `ms` in: the speed's integral. */
const ramp = (ms: number) => (((START_SPEED * DOUBLE_MS) / Math.LN2) * (2 ** (ms / DOUBLE_MS) - 1)) / 1000;
/** Moves made by itself in the first `ms` of moving by itself, up to `top` a second. */
const movedIn = (ms: number, top: number) => {
  // A top under the start speed is kept from the start.
  if (top <= START_SPEED) return (top * ms) / 1000;
  const topAt = DOUBLE_MS * Math.log2(top / START_SPEED);
  return ms <= topAt ? ramp(ms) : ramp(topAt) + (top * (ms - topAt)) / 1000;
};

/** How many moves the cursor has made by itself `held` ms after the key went down, up to `top` a second. */
export const heldMoves = (held: number, top: number) =>
  held < HOLD_DELAY_MS ? 0 : 1 + Math.floor(movedIn(held - HOLD_DELAY_MS, top));

interface Hold {
  keyCode: number;
  step: number;
  top: number;
  move: (by: number) => boolean;
  start: number;
  done: number;
  ticker?: ReturnType<typeof setInterval>;
}

// There's one remote, so one hold at a time.
let hold: Hold | undefined;
const [racing, setRacing] = createRoot(() => createSignal(false));
/** Whether a held key is moving a cursor by itself now, for lists to draw less of what flies past. */
export const heldRacing = racing;

/** Ends the hold, if there is one: the cursor stops moving by itself. */
export const stopHold = () => {
  if (!hold) return;
  clearInterval(hold.ticker);
  hold = undefined;
  setRacing(false);
};

/** Whether a held key is moving a cursor. */
export const holding = () => hold !== undefined;

const tick = () => {
  const now = hold;
  if (!now) return;
  const target = heldMoves(performance.now() - now.start, now.top);
  if (target <= now.done) return;
  const by = target - now.done;
  now.done = target;
  setRacing(true);
  if (!now.move(now.step * by)) stopHold();
};

/**
 * Moves by `step` (1 or -1) for a press, then on its own while the key is
 * held, faster and faster up to `top` moves a second. `move` is given how
 * far to move and says whether it moved; once it doesn't (at the end, or the
 * cursor's elsewhere now), the moves stop, as they do when the key is released.
 */
export const moveWhileHeld = (
  event: KeyboardEvent | undefined,
  step: number,
  top: number,
  move: (by: number) => boolean,
) => {
  // A repeat that got through, while this key is held.
  if (event && hold && hold.keyCode === event.keyCode && hold.step === step) return;
  stopHold();
  if (!move(step) || !event) return;
  const now: Hold = { keyCode: event.keyCode, step, top, move, start: performance.now(), done: 0 };
  hold = now;
  // The remote's repeats are dropped until the key is up; then the moves stop.
  suppressKeyUntilRelease(event, () => {
    if (hold === now) stopHold();
  });
  now.ticker = setInterval(tick, TICK_MS);
};
