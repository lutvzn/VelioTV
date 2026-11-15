// The app's main sections, in side-menu order. `label` is a translation key;
// `icon` is the menu's icon, from scripts/icons.
export const SECTIONS = [
  { path: "/", label: "menu.live", icon: "assets/icons/live.png" },
  { path: "/movies", label: "menu.movies", icon: "assets/icons/movies.png" },
  { path: "/series", label: "menu.series", icon: "assets/icons/series.png" },
  { path: "/settings", label: "menu.settings", icon: "assets/icons/settings.png" },
] as const;

export type Section = (typeof SECTIONS)[number];
