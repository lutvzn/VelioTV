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
  | "scrolling"
  | "pin"
  | "backup"
  | "about";

export const [settingsCategory, setSettingsCategory] = createSignal<SettingsCategory>("sources");
