import { describe, expect, it } from "vitest";
import { archiveStart, archiveUrl, catchupDays, fillTemplate, inArchive } from "./catchup";

// 2026-11-07 14:30:00 UTC, for an hour; now is 16:00.
const from = Date.UTC(2026, 10, 7, 14, 30);
const to = from + 3_600_000;
const now = from + 90 * 60_000;
const request = { from, to, now };
const S = from / 1000;

describe("catch-up", () => {
  it("fills in every kind of placeholder, in UTC", () => {
    expect(fillTemplate("{utc}-{utcend}-{lutc}-{duration}-{duration:60}-{offset:60}", request)).toBe(
      `${S}-${S + 3600}-${S + 5400}-3600-60-90`,
    );
    expect(fillTemplate("${start}/${end}/${now}/${timestamp}/${duration}/${offset}", request)).toBe(
      `${S}/${S + 3600}/${S + 5400}/${S + 5400}/3600/5400`,
    );
    expect(fillTemplate("{Y}{m}{d}-{H}{M}{S}", request)).toBe("20261107-143000");
    expect(fillTemplate("{utc:Y-m-d H:M:S}/{utcend:YmdHMS}", request)).toBe(
      "2026-11-07 14:30:00/20261107153000",
    );
    expect(fillTemplate("${(b)yyyy-MM-dd:HH-mm}/${(e)yyyyMMddHHmmss}", request)).toBe(
      "2026-11-07:14-30/20261107153000",
    );
    expect(fillTemplate("{unknown}", request)).toBe("{unknown}");
  });

  it("builds Xtream's archive URL, in the server's time zone", () => {
    const channel = { url: "http://x.test:8080/live/u/p/42.ts", catchup: { type: "xtream", days: 3 } };
    expect(archiveUrl(channel, request)).toBe("http://x.test:8080/timeshift/u/p/60/2026-11-07:14-30/42.ts");
    expect(archiveUrl(channel, { ...request, timeZone: "Europe/Berlin" })).toBe(
      "http://x.test:8080/timeshift/u/p/60/2026-11-07:15-30/42.ts",
    );
    // From M3U, as catchup="xc", and without /live/.
    expect(archiveUrl({ url: "http://x.test/u/p/42.m3u8", catchup: { type: "xc" } }, request)).toBe(
      "http://x.test/timeshift/u/p/60/2026-11-07:14-30/42.m3u8",
    );
    // A part-minute still asks for the minute.
    expect(archiveUrl(channel, { ...request, to: from + 61_000 })).toContain("/2/");
    expect(archiveUrl({ ...channel, url: "http://x.test/stream?id=42" }, request)).toBeUndefined();
  });

  it("finds the time in a time zone without formatToParts, as on the oldest TVs", () => {
    const channel = { url: "http://x.test:8080/live/u/p/42.ts", catchup: { type: "xtream", days: 3 } };
    const prototype = Intl.DateTimeFormat.prototype;
    const formatToParts = Object.getOwnPropertyDescriptor(prototype, "formatToParts");
    Reflect.deleteProperty(prototype, "formatToParts");
    try {
      expect(typeof new Intl.DateTimeFormat().formatToParts).toBe("undefined");
      expect(archiveUrl(channel, { ...request, timeZone: "Europe/Berlin" })).toBe(
        "http://x.test:8080/timeshift/u/p/60/2026-11-07:15-30/42.ts",
      );
      // Midnight there, which some browsers write as 24.
      const midnight = Date.UTC(2026, 10, 7, 23);
      expect(
        archiveUrl(channel, { from: midnight, to: midnight + 3_600_000, now, timeZone: "Europe/Berlin" }),
      ).toBe("http://x.test:8080/timeshift/u/p/60/2026-11-08:00-00/42.ts");
    } finally {
      if (formatToParts) Object.defineProperty(prototype, "formatToParts", formatToParts);
    }
  });

  it("knows where a recording really starts", () => {
    const at = Date.UTC(2026, 10, 7, 13, 29, 3, 400);
    expect(archiveStart({ catchup: { type: "xc" } }, at)).toBe(Date.UTC(2026, 10, 7, 13, 29));
    expect(archiveStart({ catchup: { type: "shift" } }, at)).toBe(Date.UTC(2026, 10, 7, 13, 29, 3));
  });

  it("builds default, append and shift URLs", () => {
    const url = "http://m.test/ts/news.ts";
    expect(
      archiveUrl(
        {
          url,
          catchup: { type: "default", source: "http://a.test/arc/{Y}-{m}-{d}/{H}{M}{S}/{duration:60}.ts" },
        },
        request,
      ),
    ).toBe("http://a.test/arc/2026-11-07/143000/60.ts");
    expect(archiveUrl({ url, catchup: { type: "append", source: "?utc={utc}&lutc={lutc}" } }, request)).toBe(
      `${url}?utc=${S}&lutc=${S + 5400}`,
    );
    // Appending to a URL that has a query already.
    expect(
      archiveUrl({ url: `${url}?token=1`, catchup: { type: "append", source: "?utc={utc}" } }, request),
    ).toBe(`${url}?token=1&utc=${S}`);
    expect(archiveUrl({ url, catchup: { type: "shift" } }, request)).toBe(`${url}?utc=${S}&lutc=${S + 5400}`);
    expect(archiveUrl({ url, catchup: { type: "timeshift" } }, request)).toBe(
      `${url}?utc=${S}&lutc=${S + 5400}`,
    );
    // Default with nothing to fill in can't be played.
    expect(archiveUrl({ url, catchup: { type: "default" } }, request)).toBeUndefined();
  });

  it("builds Flussonic URLs, for HLS and raw TS", () => {
    expect(
      archiveUrl({ url: "http://f.test/news/index.m3u8?token=x", catchup: { type: "flussonic" } }, request),
    ).toBe(`http://f.test/news/index-${S}-3600.m3u8?token=x`);
    expect(archiveUrl({ url: "http://f.test/news/mpegts", catchup: { type: "fs" } }, request)).toBe(
      `http://f.test/news/timeshift_abs-${S}.ts`,
    );
    expect(
      archiveUrl({ url: "http://f.test/news.ts", catchup: { type: "flussonic" } }, request),
    ).toBeUndefined();
  });

  it("says which programmes are in the archive", () => {
    const channel = { catchup: { type: "shift", days: 2 } };
    expect(catchupDays(channel)).toBe(2);
    expect(catchupDays({ catchup: { type: "shift" } })).toBe(1);
    expect(catchupDays({})).toBe(0);
    expect(inArchive(channel, now - 60_000, now)).toBe(true);
    expect(inArchive(channel, now - 2 * 86_400_000 - 1, now)).toBe(false);
    // Not started yet.
    expect(inArchive(channel, now + 60_000, now)).toBe(false);
    expect(inArchive({}, now - 60_000, now)).toBe(false);
  });
});
