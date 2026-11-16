// How films and series play, for each profile (PLAN.md, "Auto-play"): the
// order of the add-ons' streams, whether one plays without the picker, the
// other streams tried when it doesn't start, the next-episode card, and
// whether subtitles keep their sound descriptions. Kept as one record in
// the profile's storage (src/data/profiles.ts).
//
// The choices follow NuvioTVSmart's player settings
// (https://github.com/NuvioMedia/NuvioTVSmart, GPL-3.0:
// js/data/local/playerSettingsStore.js, js/core/player/sourceFallback.js);
// changed: rewritten in TypeScript, fewer and simpler choices.

import { createMemo, createRoot, createSignal } from "solid-js";

/** As the add-ons list them, or each add-on's best picture first. */
export type StreamOrder = "addon" | "quality";
/** No auto-play, the first stream, or the first matching a pattern. */
export type AutoPlay = "off" | "first" | "pattern";
/** When the next episode's card shows: never, at a share of the episode, or seconds before its end. */
export type NextCard = "off" | "97%" | "99%" | "60s" | "120s" | "180s";

export interface PlayChoices {
  order: StreamOrder;
  autoPlay: AutoPlay;
  /** Words or a regular expression a stream's text must have, such as "1080p|720p". */
  pattern: string;
  /** Words a stream's text mustn't have, such as "CAM|TS". */
  exclude: string;
  /** Plays the link last played for a title again, for a day, without the picker. */
  reuseLast: boolean;
  /** How many other streams are tried when one doesn't start, with auto-play on. */
  fallbacks: number;
  /** How long a stream tried that way may take to start. */
  fallbackStartMs: number;
  nextCard: NextCard;
  /** Takes out "[music]" and other sound descriptions from subtitle files. */
  hideSoundText: boolean;
}

export const PLAY_CHOICES_KEY = "velio.playChoices";

export const DEFAULT_PLAY_CHOICES: PlayChoices = {
  order: "addon",
  autoPlay: "off",
  pattern: "2160p|4k|1080p",
  exclude: "CAM|TS|HDTS|TELESYNC|SCR",
  reuseLast: false,
  fallbacks: 3,
  fallbackStartMs: 15_000,
  nextCard: "99%",
  hideSoundText: false,
};

export const FALLBACK_COUNTS = [0, 1, 2, 3, 5] as const;
export const FALLBACK_START_MS = [10_000, 15_000, 20_000, 30_000, 45_000] as const;
const ORDERS: StreamOrder[] = ["addon", "quality"];
const AUTO_PLAYS: AutoPlay[] = ["off", "first", "pattern"];
const NEXT_CARDS: NextCard[] = ["off", "97%", "99%", "60s", "120s", "180s"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const oneOf = <T>(list: readonly T[], value: unknown, fallback: T): T =>
  list.find(one => one === value) ?? fallback;

/** The kept choices, with each one that's missing or unknown at its default. */
export const readPlayChoices = (text: string | null): PlayChoices => {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "{}");
  } catch {
    value = {};
  }
  const kept = isObject(value) ? value : {};
  const base = DEFAULT_PLAY_CHOICES;
  return {
    order: oneOf(ORDERS, kept.order, base.order),
    autoPlay: oneOf(AUTO_PLAYS, kept.autoPlay, base.autoPlay),
    pattern: typeof kept.pattern === "string" ? kept.pattern.slice(0, 300) : base.pattern,
    exclude: typeof kept.exclude === "string" ? kept.exclude.slice(0, 300) : base.exclude,
    reuseLast: typeof kept.reuseLast === "boolean" ? kept.reuseLast : base.reuseLast,
    fallbacks: oneOf(FALLBACK_COUNTS, kept.fallbacks, base.fallbacks),
    fallbackStartMs: oneOf(FALLBACK_START_MS, kept.fallbackStartMs, base.fallbackStartMs),
    nextCard: oneOf(NEXT_CARDS, kept.nextCard, base.nextCard),
    hideSoundText: typeof kept.hideSoundText === "boolean" ? kept.hideSoundText : base.hideSoundText,
  };
};

export const createPlayChoices = (options: {
  storage: Pick<Storage, "getItem" | "setItem">;
  profile: () => string | undefined;
}) =>
  createRoot(() => {
    const [saved, setSaved] = createSignal(0);
    const choices = createMemo(() => {
      options.profile();
      saved();
      try {
        return readPlayChoices(options.storage.getItem(PLAY_CHOICES_KEY));
      } catch {
        return DEFAULT_PLAY_CHOICES;
      }
    });
    return {
      choices,
      set: (change: Partial<PlayChoices>) => {
        try {
          options.storage.setItem(PLAY_CHOICES_KEY, JSON.stringify({ ...choices(), ...change }));
        } catch (error) {
          console.warn("Couldn't keep the playing choices:", error);
        }
        setSaved(n => n + 1);
      },
    };
  });

export type PlayChoicesStore = ReturnType<typeof createPlayChoices>;
