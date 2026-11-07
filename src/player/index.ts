import { createSignal } from "solid-js";
import { device } from "../device";
import { setSmallVideoWindow } from "../videoWindow";
import { createPlayer, storedPreferences } from "./player";

/** The app's one player, on the TV's own engine. */
export const player = createPlayer(() => device.then(d => d.getPlayer()), {
  preferences: storedPreferences,
});

/**
 * A second player, for a small window over the main one (PLAN.md, Phase 7,
 * step 3), on TVs that can play two streams at once. It plays without sound
 * and has its own video hole, which shows while the main player has none.
 */
export const secondPlayer = createPlayer(
  () =>
    device.then(d => {
      const engine = d.getSecondPlayer();
      if (!engine) throw new Error("This TV can't play two streams at once");
      return engine;
    }),
  { showVideo: setSmallVideoWindow },
);

const [canPlaySecond, setCanPlaySecond] = createSignal(false);
void device.then(d => setCanPlaySecond(d.hasSecondPlayer()));
/** Whether the TV can play a second stream, in a small window. */
export { canPlaySecond };
