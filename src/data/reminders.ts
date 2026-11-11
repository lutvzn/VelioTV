// Reminders for programmes to come (PLAN.md, Phase 6, step 6), kept in
// localStorage. When one starts, the app shows a notice over any page, which
// offers to watch the channel (src/pages/ReminderNotice.tsx). Reminders whose
// programme has ended are dropped.

import { createSignal } from "solid-js";

const STORAGE_KEY = "velio.reminders";
const VERSION = 1;
/** At most this many reminders. */
export const MAX_REMINDERS = 200;
/** A notice shows this long before the programme starts. */
export const REMIND_BEFORE_MS = 60_000;

export interface Reminder {
  /** The channel's stable id (src/data/channelKey.ts). */
  channelId: string;
  channelName: string;
  title: string;
  start: number;
  stop: number;
}

/** One reminder per channel and start. */
export const reminderKey = (reminder: Pick<Reminder, "channelId" | "start">) =>
  `${reminder.channelId}@${reminder.start}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readReminder = (value: unknown): Reminder | undefined => {
  if (!isRecord(value)) return undefined;
  const { channelId, channelName, title, start, stop } = value;
  if (typeof channelId !== "string" || !channelId) return undefined;
  if (typeof start !== "number" || typeof stop !== "number" || !(stop > start)) return undefined;
  return {
    channelId,
    channelName: typeof channelName === "string" ? channelName : "",
    title: typeof title === "string" ? title : "",
    start,
    stop,
  };
};

/** Reads saved or restored reminders, soonest first, each once, leaving out those ended by `now`. */
export const readReminders = (list: unknown, now = Date.now()): Reminder[] => {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const reminders = list.map(readReminder).filter((reminder): reminder is Reminder => {
    if (!reminder || reminder.stop <= now || seen.has(reminderKey(reminder))) return false;
    seen.add(reminderKey(reminder));
    return true;
  });
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
  return reminders.sort((a, b) => a.start - b.start).slice(0, MAX_REMINDERS);
};

export const createReminders = (options: { storage: Storage; now?: () => number }) => {
  const now = options.now ?? Date.now;
  const load = () => {
    try {
      const saved: unknown = JSON.parse(options.storage.getItem(STORAGE_KEY) ?? "null");
      return isRecord(saved) ? readReminders(saved.reminders, now()) : [];
    } catch (error) {
      console.error("Couldn't read the reminders:", error);
      return [];
    }
  };
  const [reminders, setReminders] = createSignal<Reminder[]>(load());
  const save = (list: Reminder[]) => {
    const kept = readReminders(list, now());
    setReminders(kept);
    try {
      options.storage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, reminders: kept }));
    } catch (error) {
      console.error("Couldn't save the reminders:", error);
    }
  };
  const has = (channelId: string, start: number) =>
    reminders().some(reminder => reminder.channelId === channelId && reminder.start === start);

  return {
    /** Soonest first. */
    all: reminders,
    has,
    add: (reminder: Reminder) => {
      if (!has(reminder.channelId, reminder.start)) save([...reminders(), reminder]);
    },
    remove: (channelId: string, start: number) =>
      save(reminders().filter(reminder => reminder.channelId !== channelId || reminder.start !== start)),
    toggle(reminder: Reminder) {
      if (has(reminder.channelId, reminder.start)) this.remove(reminder.channelId, reminder.start);
      else this.add(reminder);
    },

    /**
     * The reminders due now (starting within REMIND_BEFORE_MS, and not
     * ended), which are then gone: each shows once, even across a restart.
     * Ended ones are dropped.
     */
    due: () => {
      const time = now();
      const list = reminders();
      const due = list.filter(reminder => reminder.start - REMIND_BEFORE_MS <= time && reminder.stop > time);
      if (due.length > 0 || list.some(reminder => reminder.stop <= time)) {
        save(list.filter(reminder => !due.includes(reminder)));
      }
      return due;
    },

    replace: (list: unknown) => save(readReminders(list, now())),
    /** Reads them again from storage, such as for another profile (src/data/profiles.ts). */
    reload: () => setReminders(load()),
  };
};

export type Reminders = ReturnType<typeof createReminders>;
