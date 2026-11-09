// The app's own settings (PLAN.md, Phase 5, steps 5 and 6), kept in
// localStorage like the sources and edits, and backed up with them: the
// language, what the app opens on, how times show, how fast a held key
// moves through lists, and the parental PIN.
//
// The PIN is four digits, kept as typed: it keeps children out of locked
// channels, not anyone who can read the TV's storage. Once entered, locked
// channels stay open until the app closes.

import { createRoot, createSignal } from "solid-js";
import { isLanguage, type LanguageSetting } from "../lang/languages";

const STORAGE_KEY = "velio.settings";
const STORAGE_VERSION = 1;
export const PIN_LENGTH = 4;

/** Full screen on the last channel watched, or the guide. */
export type StartOn = "last" | "guide";
export type ClockFormat = "24h" | "12h";
/** The lists a held Up or Down moves through faster and faster (src/heldKey.ts). */
export type HoldList = "groups" | "guide" | "posters";
export const HOLD_LISTS: readonly HoldList[] = ["groups", "guide", "posters"];
/** The top speeds offered, in moves a second. */
export const HOLD_SPEEDS = [5, 10, 15, 20, 30, 40, 60] as const;
export const DEFAULT_HOLD_SPEED = 20;

export interface AppSettings {
  /** A language, or "auto" for the TV's (PLAN.md, Phase 8, step 5). */
  language: LanguageSetting;
  startOn: StartOn;
  clock: ClockFormat;
  /** Each list's top speed for a held key, in moves a second. */
  holdSpeeds: Record<HoldList, number>;
  /** The parental PIN, if one is set. */
  pin?: string;
}

export const defaultSettings = (): AppSettings => ({
  language: "auto",
  startOn: "last",
  clock: "24h",
  holdSpeeds: { groups: DEFAULT_HOLD_SPEED, guide: DEFAULT_HOLD_SPEED, posters: DEFAULT_HOLD_SPEED },
});

const isHoldSpeed = (value: unknown): value is number => (HOLD_SPEEDS as readonly unknown[]).includes(value);

export const isPin = (value: unknown): value is string =>
  typeof value === "string" && value.length === PIN_LENGTH && /^\d+$/.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads saved or restored settings, leaving out what doesn't fit. */
export const readSettings = (value: unknown): AppSettings => {
  const settings = defaultSettings();
  if (!isRecord(value)) return settings;
  const record = value;
  if (record.language === "auto" || isLanguage(record.language)) settings.language = record.language;
  if (record.startOn === "last" || record.startOn === "guide") settings.startOn = record.startOn;
  if (record.clock === "24h" || record.clock === "12h") settings.clock = record.clock;
  if (isRecord(record.holdSpeeds)) {
    for (const list of HOLD_LISTS) {
      const speed = record.holdSpeeds[list];
      if (isHoldSpeed(speed)) settings.holdSpeeds[list] = speed;
    }
  }
  if (isPin(record.pin)) settings.pin = record.pin;
  return settings;
};

const load = (storage: Storage) => {
  try {
    return readSettings(JSON.parse(storage.getItem(STORAGE_KEY) ?? "null"));
  } catch (error) {
    console.error("Couldn't read the settings:", error);
    return defaultSettings();
  }
};

export const createAppSettings = (options: { storage: Storage }) =>
  createRoot(() => {
    const [settings, setSettings] = createSignal(load(options.storage));
    const [unlocked, setUnlocked] = createSignal(false);

    const save = (next: AppSettings) => {
      setSettings(next);
      try {
        options.storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...next }));
      } catch (error) {
        console.error("Couldn't save the settings:", error);
      }
    };
    const set = (change: Partial<AppSettings>) => save({ ...settings(), ...change });

    return {
      /** Everything, as stored and backed up. */
      all: settings,
      replace: (next: unknown) => {
        save(readSettings(next));
        setUnlocked(false);
      },
      language: () => settings().language,
      setLanguage: (language: LanguageSetting) => set({ language }),
      startOn: () => settings().startOn,
      setStartOn: (startOn: StartOn) => set({ startOn }),
      clock: () => settings().clock,
      setClock: (clock: ClockFormat) => set({ clock }),
      /** A list's top speed for a held key, in moves a second. */
      holdSpeed: (list: HoldList) => settings().holdSpeeds[list],
      setHoldSpeed: (list: HoldList, speed: number) =>
        set({ holdSpeeds: { ...settings().holdSpeeds, [list]: speed } }),

      hasPin: () => settings().pin !== undefined,
      /** Sets a new PIN, or with undefined removes it. Setting one leaves locks open this session. */
      setPin: (pin: string | undefined) => {
        if (pin !== undefined && !isPin(pin)) return false;
        const next = { ...settings() };
        if (pin === undefined) delete next.pin;
        else next.pin = pin;
        save(next);
        setUnlocked(pin !== undefined);
        return true;
      },
      /** Whether `pin` is the PIN; a right one opens locked channels until the app closes. */
      checkPin: (pin: string) => {
        const right = settings().pin !== undefined && pin === settings().pin;
        if (right) setUnlocked(true);
        return right;
      },
      /** Locked channels play without asking: the PIN was entered, or none is set. */
      unlocked: () => unlocked() || settings().pin === undefined,
      /** Asks for the PIN again, as at the next start. */
      lock: () => setUnlocked(false),
    };
  });

export type AppSettingsStore = ReturnType<typeof createAppSettings>;
