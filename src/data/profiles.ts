// Profiles on the TV (SYNC-PLAN.md, step 5). A TV signed in to a Velio
// account has the profiles the owner gave it; each sees its own lists
// (plus the TV's own sources, which are every profile's) and keeps its own
// favourites and channel edits, what was watched, reminders and the last
// channel. A TV that isn't signed in has no profiles and works as before.
//
// The per-profile data lives under the same keys with "@<profile id>" on
// the end, such as "velio.watched@k7QM…". profileStorage() adds that part,
// so the stores keep their own keys and only reload when the profile
// changes. The app's settings stay the TV's: the clock, language, scrolling
// and tracks are about the TV and who sits at it changes nothing there, and
// the parental PIN guards the TV (SYNC-PLAN.md, open choice 2).
//
// The profile last chosen is kept per TV as "velio.profile".

import { createRoot, createSignal } from "solid-js";
import type { DeviceProfile, DeviceView } from "./accountView";

export const PROFILE_KEY = "velio.profile";

/** The keys each profile has its own of. */
export const PER_PROFILE_KEYS: readonly string[] = [
  "velio.channelEdits",
  "velio.watched",
  "velio.reminders",
  "velio.lastChannel",
  "velio.vodLayout",
  "velio.vodCategories",
  "velio.vodSorts",
  "velio.vodPins",
  "velio.playChoices",
  "velio.lastLinks",
];

/** The key a profile keeps `key` under; the key itself with no profile or for a key every profile shares. */
export const profileKey = (key: string, profile: string | undefined) =>
  profile && PER_PROFILE_KEYS.includes(key) ? `${key}@${profile}` : key;

/** `base`, with the per-profile keys under the profile `profile()` answers. */
export const profileStorage = (base: Storage, profile: () => string | undefined): Storage => ({
  get length() {
    return base.length;
  },
  clear: () => base.clear(),
  key: index => base.key(index),
  getItem: key => base.getItem(profileKey(key, profile())),
  setItem: (key, value) => base.setItem(profileKey(key, profile()), value),
  removeItem: key => base.removeItem(profileKey(key, profile())),
});

export interface ProfilesOptions {
  storage: Storage;
  /** The profiles this TV has, from its last pull; none while signed out. */
  profiles: () => readonly DeviceProfile[];
}

const readChosen = (storage: Storage) => {
  try {
    return storage.getItem(PROFILE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const tryRemove = (storage: Storage, key: string) => {
  try {
    storage.removeItem(key);
  } catch (error) {
    console.error(`Couldn't remove ${key}:`, error);
  }
};

export const createProfiles = (options: ProfilesOptions) =>
  createRoot(() => {
    const { storage } = options;
    const [chosen, setChosen] = createSignal(readChosen(storage));

    const find = (id: string | undefined) =>
      id === undefined ? undefined : options.profiles().find(profile => profile.id === id);
    /** The profile in use: the one chosen, while the TV still has it. The stores reload when it changes. */
    const current = () => find(chosen());
    const currentId = () => current()?.id;

    const choose = (id: string | undefined) => {
      if (id !== undefined && !find(id)) return false;
      setChosen(id);
      try {
        if (id === undefined) storage.removeItem(PROFILE_KEY);
        else storage.setItem(PROFILE_KEY, id);
      } catch (error) {
        console.error("Couldn't save the profile:", error);
      }
      return true;
    };

    /** Deletes a profile's own data on this TV. */
    const forgetData = (id: string) => {
      for (const key of PER_PROFILE_KEYS) tryRemove(storage, profileKey(key, id));
    };

    return {
      list: options.profiles,
      current,
      currentId,
      find,
      choose,

      /**
       * Whether the picker must open: the TV has profiles and none is in use,
       * other than one with no PIN, which is chosen by itself.
       */
      needsPick: () => {
        const list = options.profiles();
        if (list.length === 0 || current()) return false;
        return !(list.length === 1 && !list[0].locked);
      },
      /** Chooses the TV's only profile when it has no PIN; whether it did. */
      chooseOnly: () => {
        const list = options.profiles();
        if (current() || list.length !== 1 || list[0].locked) return false;
        return choose(list[0].id);
      },

      /**
       * After a pull: on the first one, the TV's data so far becomes the first
       * profile's; profiles taken from the TV lose their data, and if the
       * current one went, the picker opens.
       */
      viewChanged: (view: DeviceView, before: DeviceView | undefined) => {
        const first = view.profiles[0];
        if (!before && first) {
          for (const key of PER_PROFILE_KEYS) {
            try {
              const value = storage.getItem(key);
              const target = profileKey(key, first.id);
              if (value !== null && storage.getItem(target) === null) storage.setItem(target, value);
            } catch (error) {
              console.error(`Couldn't copy ${key} to the first profile:`, error);
            }
          }
        }
        const kept = new Set(view.profiles.map(profile => profile.id));
        for (const profile of before?.profiles ?? []) if (!kept.has(profile.id)) forgetData(profile.id);
        const id = chosen();
        if (id !== undefined && !kept.has(id)) choose(undefined);
      },

      /** The TV left the account: every profile's data goes, and the TV's own is used again. */
      signedOut: (view: DeviceView | undefined) => {
        for (const profile of view?.profiles ?? []) forgetData(profile.id);
        setChosen(undefined);
        tryRemove(storage, PROFILE_KEY);
      },
    };
  });

export type Profiles = ReturnType<typeof createProfiles>;
