import { createSignal } from "solid-js";

// The category Settings shows, kept while the app runs, so Settings opens
// again where it was left; other pages can open it on one, as the notice
// about being signed out does with the account.

export type SettingsCategory =
  | "sources"
  | "account"
  | "addons"
  | "general"
  | "live"
  | "vod"
  | "playing"
  | "debrid"
  | "scrolling"
  | "pin"
  | "backup"
  | "about";

export const [settingsCategory, setSettingsCategory] = createSignal<SettingsCategory>("sources");

/** What Settings does as it opens, when another page opened it for it. */
export type SettingsAction = "signIn" | "addSource";

let pending: SettingsAction | undefined;

/**
 * Asks Settings, the next time it opens, to show the category this action
 * is in and do it there, with the keys in the panel: signing in on the
 * account, or opening the form to add a source.
 */
export const openSettingsFor = (action: SettingsAction) => {
  pending = action;
  setSettingsCategory(action === "signIn" ? "account" : "sources");
};

/** The action asked for, once: whoever reads it does it. */
export const takeSettingsAction = (category: SettingsCategory): SettingsAction | undefined => {
  const want = pending === "signIn" ? "account" : pending === "addSource" ? "sources" : undefined;
  if (want !== category) return undefined;
  const action = pending;
  pending = undefined;
  return action;
};

/** Whether an action is waiting for Settings to open. */
export const settingsActionPending = () => pending !== undefined;
