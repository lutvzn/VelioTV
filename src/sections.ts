// The app's main sections, in side-menu order. `label` is a translation key.
export const SECTIONS = [
  { path: "/", label: "menu.live" },
  { path: "/guide", label: "menu.guide" },
  { path: "/movies", label: "menu.movies" },
  { path: "/series", label: "menu.series" },
  { path: "/settings", label: "menu.settings" },
] as const;

export type Section = (typeof SECTIONS)[number];
