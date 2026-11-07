import { device } from "../device";
import { createPlayer, storedPreferences } from "./player";

/** The app's one player, on the TV's own engine. */
export const player = createPlayer(() => device.then(d => d.getPlayer()), {
  preferences: storedPreferences,
});
