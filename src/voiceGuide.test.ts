import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announcementOf, lastSaid, say, sayWhileFocused, setVoiceGuideOn, textOf } from "./voiceGuide";

const text = (value: string, extra = {}) => ({ _type: "textNode", getText: () => value, ...extra });
const view = (children: object[], extra = {}) => ({ _type: "element", children, ...extra });

/** What the region holds once the wait is over. */
const heard = () => {
  vi.advanceTimersByTime(400);
  return lastSaid();
};

describe("the voice guide", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVoiceGuideOn(true);
    say("reset");
    heard();
  });
  afterEach(() => {
    setVoiceGuideOn(false);
    vi.useRealTimers();
  });

  it("reads a node's text in order, leaving out what's hidden", () => {
    const node = view([
      text("Settings"),
      view([text("  Clock "), text("hidden", { hidden: true })]),
      view([text("faded")], { alpha: 0 }),
      text(""),
      text("24-hour"),
    ]);
    expect(textOf(node)).toEqual(["Settings", "Clock", "24-hour"]);
    expect(announcementOf(node)).toEqual(["Settings", "Clock", "24-hour"]);
    expect(announcementOf({ ...node, announce: "Language" })).toEqual(["Language"]);
    expect(announcementOf({ ...node, announce: "" })).toEqual([]);
  });

  it("reads only the last thing asked for, and nothing while it's off", () => {
    say("one");
    say(["two", undefined, "three"]);
    expect(heard()).toBe("two. three");
    setVoiceGuideOn(false);
    say("four");
    expect(heard()).toBe("two. three");
  });

  it("reads a cursor's context once, then only what changed", () => {
    const page = createRoot(dispose => {
      const [focused, setFocused] = createSignal(false);
      const [channel, setChannel] = createSignal("1 News");
      const [programme, setProgramme] = createSignal("Morning");
      sayWhileFocused(focused, () => [channel(), programme()]);
      return { setFocused, setChannel, setProgramme, dispose };
    });

    page.setFocused(true);
    expect(heard()).toBe("1 News. Morning");
    page.setProgramme("Noon");
    expect(heard()).toBe("Noon");
    page.setChannel("2 Sport");
    expect(heard()).toBe("2 Sport. Noon");
    // Back on the page: all of it again.
    page.setFocused(false);
    page.setFocused(true);
    expect(heard()).toBe("2 Sport. Noon");
    page.dispose();
  });
});
