// Ties the player to the app's visibility and the TV's network (PLAN.md,
// Phase 3, step 6). Tizen and webOS both hide a web app on Home or when
// another app opens, and both report it with `visibilitychange`.

import type { Player } from "./player";

type Lifecycle = Pick<Player, "suspend" | "resume" | "setOnline">;

export const watchLifecycle = (player: Lifecycle, page: Document = document, net: Window = window) => {
  const visibility = () => (page.visibilityState === "hidden" ? player.suspend() : player.resume());
  const online = () => player.setOnline(true);
  const offline = () => player.setOnline(false);
  page.addEventListener("visibilitychange", visibility);
  net.addEventListener("online", online);
  net.addEventListener("offline", offline);
  player.setOnline(net.navigator.onLine);
  return () => {
    page.removeEventListener("visibilitychange", visibility);
    net.removeEventListener("online", online);
    net.removeEventListener("offline", offline);
  };
};
