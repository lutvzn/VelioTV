// The app's look: its colours, corners, type and motion, in one place, so
// every page draws from the same few values. Colours are "#rrggbbaa"; the
// build turns them into numbers (@lightningtv/vite-hex-transform).
//
// The style (reference/stitch_smart_iptv_media_player/): a deep blue-black
// canvas for dark living rooms, surfaces as faint blue-white washes, and one
// bright accent, electric cyan, for what has the focus: buttons and rows fill
// with it, with dark text, and cards take a cyan ring with a glow. Amber
// marks time and favourites: ratings, reminders, catch-up, seeking.

export const colors = {
  /** The app's background, behind every page. */
  background: "#07090eff",
  /** The menu rail's background, and the guide's groups beside it; opaque, as they're drawn over the page. */
  menu: "#0a0e17ff",
  /** Panels drawn over a page or over video, such as the options. */
  panel: "#0a0e17f2",
  /** A dialog over everything, such as the PIN prompt. */
  dialog: "#0e131ffa",
  /** A card or row at rest. */
  surface: "#8fa8d614",
  /** A card or row that stands out a little, such as the row under the cursor. */
  surfaceRaised: "#8fa8d626",
  /** An empty or faint area. */
  surfaceFaint: "#8fa8d60a",
  /** A card at rest, opaque. */
  card: "#0e131fff",
  /** The opaque fill inside a focus ring, which mustn't let the ring show through. */
  highlight: "#161d2eff",
  /** Hairlines between areas, and the edge of a card at rest. */
  line: "#ffffff12",
  /** What has the focus. */
  focus: "#00e5ffff",
  /** Text and icons on the focus colour. */
  onFocus: "#00252aff",

  text: "#f5f8fcff",
  /** Secondary text, such as hints and descriptions. */
  textDim: "#9eabbfff",
  /** Tertiary text, such as counts, or ended programmes' times. */
  textFaint: "#5f6b80ff",

  accent: "#00e5ffff",
  /** The accent's top and bottom, for the logo. */
  accentTop: "#6ef3ffff",
  accentBottom: "#00a9c4ff",
  /** The accent as a wash, such as the section you're in. */
  accentWash: "#00e5ff1f",
  /** A faint wash of the accent at the top of a page with no picture. */
  accentGlow: "#00e5ff17",
  /** Text in the accent colour. */
  accentText: "#00e5ffff",

  /** Ratings, favourites, reminders, catch-up and seeking. */
  gold: "#ffb300ff",
  goldWash: "#ffb30059",
  /** The guide's line at the current time, and live markers. */
  live: "#ff5468ff",
  /** Text on the live colour. */
  onLive: "#3d000aff",
  /** The menu's light when connected to a Velio server. */
  online: "#34d27bff",
  danger: "#ff6b6bff",
  dangerFill: "#e5484dff",

  /** A progress bar's track. */
  track: "#ffffff26",
  /** A progress bar's track on the focus colour. */
  trackOnFocus: "#00252a33",
  /** Scrims over video and artwork, from clear to dark. */
  scrimClear: "#07090e00",
  scrimLight: "#07090e33",
  scrimSoft: "#07090eb3",
  scrim: "#07090eeb",
  scrimSolid: "#07090eff",
  /** A caption or message over video. */
  caption: "#000000bf",
  transparent: "#00000000",
} as const;

export const radius = {
  small: 8,
  medium: 12,
  large: 16,
  xlarge: 24,
  /** Half a 64-high pill; set it to half the height for others. */
  pill: 32,
};

/** The bold face; scripts/fonts/build.mjs builds both. */
export const BOLD = "NotoSans700";

/** Focus motion, such as a poster growing as the cursor reaches it. */
export const motion = {
  quick: { duration: 140, easing: "ease-out" },
  normal: { duration: 150, easing: "ease-out" },
} as const;

/** The cyan glow around a focused card or button. */
export const focusShadow = { color: "#00e5ff5c", blur: 30, spread: 0, x: 0, y: 0 };

/** The shadow under a raised card, such as a page's poster. */
export const raisedShadow = { color: "#000000b3", blur: 36, spread: 2, x: 0, y: 14 };

/** The shadow under a dialog over everything, such as the PIN prompt. */
export const dialogShadow = { color: "#000000cc", blur: 70, spread: 0, x: 0, y: 22 };

/** The width of a focused card's cyan ring. */
export const RING = 3;

/** The text colour on a row or button, given whether it has the focus. */
export const textOn = (focused: boolean, dim = false) =>
  focused ? colors.onFocus : dim ? colors.textDim : colors.text;
