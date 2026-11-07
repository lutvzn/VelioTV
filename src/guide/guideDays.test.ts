import { createRoot, createMemo } from "solid-js";
import { describe, expect, it } from "vitest";
import { createGuideCache } from "../data/guideCache";
import { DAY, type StoredProgramme } from "../data/guideCodec";
import type { Channel } from "../data/lineup";
import { createGuideDays, daysBetween } from "./guideDays";

const HOUR = 3_600_000;
const day = 20_000;
const channel = (guideId?: string): Channel => ({
  source: "s",
  id: `s/${guideId ?? "none"}`,
  index: 0,
  name: guideId ?? "No guide",
  url: "http://a/1.ts",
  guideId,
});
const show = (title: string, start: number, hours = 1): StoredProgramme => ({
  title,
  start,
  stop: start + hours * HOUR,
});

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("guide days", () => {
  it("lists the UTC days a span overlaps", () => {
    expect(daysBetween(day * DAY + HOUR, day * DAY + 3 * HOUR)).toEqual([day]);
    expect(daysBetween(day * DAY - HOUR, day * DAY + HOUR)).toEqual([day - 1, day]);
    expect(daysBetween(day * DAY, (day + 1) * DAY)).toEqual([day]);
  });

  it("reads the days a row needs, and updates the row when they arrive", async () => {
    const reads: number[] = [];
    const late = show("Late", day * DAY - HOUR, 2);
    const guide = createGuideCache({
      read: (_source, _id, d) => {
        reads.push(d);
        return Promise.resolve(d === day - 1 ? [late] : [late, show("Early", day * DAY + HOUR)]);
      },
    });
    const days = createGuideDays(guide);
    const { titles, dispose } = createRoot(stop => ({
      titles: createMemo(() =>
        days.programmes(channel("one"), day * DAY - 2 * HOUR, day * DAY + 2 * HOUR)?.map(p => p.title),
      ),
      dispose: stop,
    }));

    expect(titles()).toBeUndefined();
    await settle();
    expect(titles()).toEqual(["Late", "Early"]);
    // Each day read once, even though the row asked again.
    expect(reads).toHaveLength(2);
    expect(new Set(reads)).toEqual(new Set([day - 1, day]));
    dispose();
  });

  it("gives a channel without a guide no programmes, and a failed day none", async () => {
    const guide = createGuideCache({ read: () => Promise.reject(new Error("broken")) });
    const days = createGuideDays(guide);
    expect(days.programmes(channel(), 0, HOUR)).toEqual([]);
    expect(days.programmes(channel("one"), day * DAY, day * DAY + HOUR)).toBeUndefined();
    await settle();
    expect(days.programmes(channel("one"), day * DAY, day * DAY + HOUR)).toEqual([]);
    expect(days.stats).toMatchObject({ requested: 1, failed: 1 });
  });

  it("reads ahead without reading a day twice", async () => {
    const reads: string[] = [];
    const guide = createGuideCache({
      read: (_source, id, d) => {
        reads.push(`${id}/${d}`);
        return Promise.resolve([]);
      },
    });
    const days = createGuideDays(guide);
    const list = [channel("one"), channel(), channel("two")];
    days.prefetch(list, day * DAY, day * DAY + HOUR);
    days.prefetch(list, day * DAY, day * DAY + HOUR);
    await settle();
    days.prefetch(list, day * DAY, day * DAY + HOUR);
    expect(reads).toEqual([`one/${day}`, `two/${day}`]);
  });
});
