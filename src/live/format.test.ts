import { describe, expect, it } from "vitest";
import { clockTime, dayLabel, duration } from "./format";

const at = (hours: number, minutes: number) => new Date(2026, 10, 7, hours, minutes).getTime();

describe("clock times", () => {
  it("show on a 24-hour or a 12-hour clock", () => {
    expect(clockTime(at(0, 5))).toBe("00:05");
    expect(clockTime(at(21, 30), false)).toBe("21:30");
    expect(clockTime(at(0, 5), true)).toBe("12:05 AM");
    expect(clockTime(at(12, 0), true)).toBe("12:00 PM");
    expect(clockTime(at(21, 30), true)).toBe("9:30 PM");
  });

  it("name yesterday, today and tomorrow", () => {
    const words = { today: "Today", tomorrow: "Tomorrow", yesterday: "Yesterday" };
    const day = 86_400_000;
    expect(dayLabel(at(9, 0), at(12, 0), words)).toBe("Today");
    expect(dayLabel(at(9, 0) + day, at(12, 0), words)).toBe("Tomorrow");
    expect(dayLabel(at(9, 0) - day, at(12, 0), words)).toBe("Yesterday");
  });

  it("show lengths with hours only when there are any", () => {
    expect(duration(0)).toBe("0:00");
    expect(duration(83_500)).toBe("1:23");
    expect(duration(3_723_000)).toBe("1:02:03");
  });
});
