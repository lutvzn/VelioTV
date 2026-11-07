// Times as Live TV shows them, in the TV's time zone: a 24-hour clock, or a
// 12-hour one if the user picks it in Settings (PLAN.md, Phase 5, step 6).

import { createSignal } from "solid-js";

const pad = (value: number) => String(value).padStart(2, "0");

const [twelveHour, setTwelveHour] = createSignal(false);
/** Picks the clock every time shown uses; the library follows the setting. */
export { setTwelveHour };

export const clockTime = (ms: number, twelve = twelveHour()) => {
  const date = new Date(ms);
  const minutes = pad(date.getMinutes());
  if (!twelve) return `${pad(date.getHours())}:${minutes}`;
  const hours = date.getHours();
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
};

export const timeRange = (start: number, stop: number) => `${clockTime(start)}–${clockTime(stop)}`;

/** How far through a programme `at` is, from 0 to 1. */
export const progress = (start: number, stop: number, at: number) =>
  stop <= start ? 0 : Math.max(0, Math.min(1, (at - start) / (stop - start)));

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** "Today", "Tomorrow" or a short date, for the local day `ms` falls in. */
export const dayLabel = (ms: number, now: number, words: { today: string; tomorrow: string }) => {
  // Rounded, as a day with a clock change is an hour longer or shorter.
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  if (days === 0) return words.today;
  if (days === 1) return words.tomorrow;
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};
