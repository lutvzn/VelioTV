import { describe, expect, it } from "vitest";
import { createGuideCache, nowAndNext } from "./guideCache";
import { DAY, type StoredProgramme } from "./guideCodec";

const HOUR = 3_600_000;
const day = 20_000;
const base = day * DAY;
const show = (title: string, start: number, hours = 1): StoredProgramme => ({
  title,
  start: base + start * HOUR,
  stop: base + (start + hours) * HOUR,
});

describe("now and next", () => {
  it("finds the programme on and the one after, across a gap", () => {
    const programmes = [show("A", 1), show("B", 2), show("C", 4)];
    expect(nowAndNext(programmes, base + 1.5 * HOUR)).toEqual({ now: programmes[0], next: programmes[1] });
    expect(nowAndNext(programmes, base + 3 * HOUR)).toEqual({ now: undefined, next: programmes[2] });
    expect(nowAndNext(programmes, base + 6 * HOUR)).toEqual({});
  });
});

describe("the guide cache", () => {
  it("reads a channel's day once, keeps a few, and looks into tomorrow", async () => {
    const reads: string[] = [];
    const cache = createGuideCache({
      size: 2,
      read: async (source, guideId, d) => {
        reads.push(`${guideId}@${d}`);
        if (d === day) return [show("Late", 23), show("Early", 0, 23)];
        return [show("Tomorrow", 24)];
      },
    });

    const at = base + 23.5 * HOUR;
    expect(await cache.nowAndNext("s", "one", at)).toEqual({
      now: show("Late", 23),
      next: show("Tomorrow", 24),
    });
    expect(reads).toEqual([`one@${day}`, `one@${day + 1}`]);
    // Sorted by start.
    expect(cache.peek("s", "one", day)?.map(p => p.title)).toEqual(["Early", "Late"]);

    await cache.nowAndNext("s", "one", at);
    expect(reads).toHaveLength(2);

    // A third day pushes out the one used longest ago.
    await cache.day("s", "two", day);
    expect(cache.peek("s", "one", day)).toBeUndefined();
    expect(cache.peek("s", "one", day + 1)).toBeDefined();

    cache.clear();
    expect(cache.peek("s", "two", day)).toBeUndefined();
  });

  it("reads again after a failed read", async () => {
    let calls = 0;
    const cache = createGuideCache({
      read: () => (++calls === 1 ? Promise.reject(new Error("busy")) : Promise.resolve([show("A", 1)])),
    });
    await expect(cache.day("s", "one", day)).rejects.toThrow("busy");
    expect(await cache.day("s", "one", day)).toHaveLength(1);
  });
});
