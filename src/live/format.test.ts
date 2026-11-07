import { describe, expect, it } from "vitest";
import { clockTime } from "./format";

const at = (hours: number, minutes: number) => new Date(2026, 10, 7, hours, minutes).getTime();

describe("clock times", () => {
  it("show on a 24-hour or a 12-hour clock", () => {
    expect(clockTime(at(0, 5))).toBe("00:05");
    expect(clockTime(at(21, 30), false)).toBe("21:30");
    expect(clockTime(at(0, 5), true)).toBe("12:05 AM");
    expect(clockTime(at(12, 0), true)).toBe("12:00 PM");
    expect(clockTime(at(21, 30), true)).toBe("9:30 PM");
  });
});
