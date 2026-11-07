import { describe, expect, it } from "vitest";
import { memoryStorage } from "./memoryStorage";
import { REMIND_BEFORE_MS, createReminders } from "./reminders";

const MINUTE = 60_000;
const reminder = (start: number, channelId = "s/i:1") => ({
  channelId,
  channelName: "News",
  title: `At ${start}`,
  start,
  stop: start + 30 * MINUTE,
});

describe("reminders", () => {
  it("are kept across a restart, soonest first, once each", () => {
    const storage = memoryStorage();
    const reminders = createReminders({ storage, now: () => 0 });
    reminders.add(reminder(90 * MINUTE));
    reminders.add(reminder(30 * MINUTE));
    reminders.add(reminder(30 * MINUTE));
    reminders.toggle(reminder(60 * MINUTE, "s/i:2"));
    expect(reminders.has("s/i:2", 60 * MINUTE)).toBe(true);
    const again = createReminders({ storage, now: () => 0 });
    expect(again.all().map(one => one.start)).toEqual([30 * MINUTE, 60 * MINUTE, 90 * MINUTE]);
    again.toggle(reminder(60 * MINUTE, "s/i:2"));
    expect(again.has("s/i:2", 60 * MINUTE)).toBe(false);
  });

  it("come due once, a minute before the start, and go once the programme ends", () => {
    let time = 0;
    const storage = memoryStorage();
    const reminders = createReminders({ storage, now: () => time });
    reminders.add(reminder(10 * MINUTE));
    reminders.add(reminder(20 * MINUTE));
    time = 10 * MINUTE - REMIND_BEFORE_MS - 1;
    expect(reminders.due()).toEqual([]);
    time += 1;
    expect(reminders.due().map(one => one.start)).toEqual([10 * MINUTE]);
    expect(reminders.due()).toEqual([]);
    // Shown, it's gone, so it doesn't show again at the next start.
    expect(createReminders({ storage, now: () => time }).due()).toEqual([]);
    // Past its end, it's dropped; the later one still shows while it's on.
    time = 45 * MINUTE;
    expect(reminders.due().map(one => one.start)).toEqual([20 * MINUTE]);
    expect(reminders.all()).toEqual([]);
  });

  it("read restored ones carefully", () => {
    const reminders = createReminders({ storage: memoryStorage(), now: () => 0 });
    reminders.replace([
      reminder(MINUTE),
      { channelId: "x", start: 5, stop: 1 },
      "nonsense",
      { start: 1, stop: 2 },
    ]);
    expect(reminders.all()).toEqual([reminder(MINUTE)]);
  });
});
