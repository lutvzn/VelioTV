import { describe, expect, it } from "vitest";
import type { AddonStream } from "../stremio/addon";
import { createLastLinks, LAST_LINK_MS } from "./lastLinks";
import { memoryStorage } from "./memoryStorage";

const stream = (url: string): AddonStream => ({ url, name: "", description: "", subtitles: [] });

describe("the last links played", () => {
  it("play a link again for a day, then forget it", () => {
    let time = 1_000_000;
    const links = createLastLinks({ storage: memoryStorage(), now: () => time });
    links.keep({ key: "film", addon: "a", addonName: "A", stream: stream("one") });
    expect(links.find("film")?.stream.url).toBe("one");
    expect(links.find("other")).toBeUndefined();
    time += LAST_LINK_MS;
    expect(links.find("film")).toBeUndefined();
  });

  it("keep the newest for each title, and forget one that failed", () => {
    const links = createLastLinks({ storage: memoryStorage() });
    links.keep({ key: "film", addon: "a", addonName: "A", stream: stream("one") });
    links.keep({ key: "film", addon: "b", addonName: "B", stream: stream("two") });
    links.keep({ key: "show", addon: "a", addonName: "A", stream: stream("three") });
    expect(links.find("film")?.stream.url).toBe("two");
    links.forget("film");
    expect(links.find("film")).toBeUndefined();
    expect(links.find("show")?.stream.url).toBe("three");
  });

  it("read nothing from a record that doesn't read", () => {
    const storage = memoryStorage();
    storage.setItem("velio.lastLinks", "{oops");
    expect(createLastLinks({ storage }).find("film")).toBeUndefined();
  });
});
