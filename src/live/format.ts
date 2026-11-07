// Times as Live TV shows them: 24-hour clock, in the TV's time zone.

const pad = (value: number) => String(value).padStart(2, "0");

export const clockTime = (ms: number) => {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const timeRange = (start: number, stop: number) => `${clockTime(start)}–${clockTime(stop)}`;

/** How far through a programme `at` is, from 0 to 1. */
export const progress = (start: number, stop: number, at: number) =>
  stop <= start ? 0 : Math.max(0, Math.min(1, (at - start) / (stop - start)));
