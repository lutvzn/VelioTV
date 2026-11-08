import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, ChannelGroup } from "../data/lineup";
import { createZapper } from "./zapper";

const channel = (index: number, extra: Partial<Channel> = {}): Channel => ({
  source: "s",
  id: `s/${index}`,
  index,
  name: `Channel ${index}`,
  url: `http://a/${index}.ts`,
  ...extra,
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

const setup = (list: Channel[], storage = memoryStorage()) =>
  createRoot(dispose => {
    const [channels, setChannels] = createSignal(list);
    const groups = (): ChannelGroup[] => {
      const byName = new Map<string, Channel[]>();
      for (const c of channels()) byName.set(c.group ?? "", [...(byName.get(c.group ?? "") ?? []), c]);
      return Array.from(byName, ([name, members]) => ({ name, channels: members }));
    };
    const played: string[] = [];
    const zapper = createZapper({
      channels,
      groups,
      find: id => channels().find(c => c.id === id),
      play: c => played.push(c.id),
      storage,
      zapDelayMs: 400,
      numberDelayMs: 2000,
    });
    return { zapper, played, setChannels, storage, dispose };
  });

afterEach(() => vi.useRealTimers());

describe("the zapper", () => {
  it("starts on the remembered channel, or the first", () => {
    const storage = memoryStorage();
    const first = setup([channel(0), channel(1), channel(2)], storage);
    expect(first.zapper.start(false)).toBe(true);
    expect(first.played).toEqual(["s/0"]);

    first.zapper.tune(channel(2));
    const second = setup([channel(0), channel(1), channel(2)], storage);
    second.zapper.start(false);
    expect(second.played).toEqual(["s/2"]);
    expect(second.zapper.shown()?.id).toBe("s/2");
  });

  it("waits for the remembered channel while sources load", () => {
    const storage = memoryStorage();
    storage.setItem("velio.lastChannel", "other/5");
    const { zapper, played } = setup([channel(0)], storage);
    expect(zapper.start(true)).toBe(false);
    expect(setup([], storage).zapper.start(false)).toBe(false);
    expect(zapper.start(false)).toBe(true);
    expect(played).toEqual(["s/0"]);
  });

  it("shows each zap at once and plays only where it stops", () => {
    vi.useFakeTimers();
    const { zapper, played } = setup([channel(0), channel(1), channel(2)]);
    zapper.start(false);
    zapper.zap(1);
    expect(zapper.shown()?.id).toBe("s/1");
    expect(zapper.pending()).toBe(true);
    vi.advanceTimersByTime(300);
    zapper.zap(1);
    vi.advanceTimersByTime(300);
    // Wraps round from the last channel to the first.
    zapper.zap(1);
    expect(zapper.shown()?.id).toBe("s/0");
    zapper.zap(-1);
    expect(played).toEqual(["s/0"]);
    vi.advanceTimersByTime(400);
    expect(played).toEqual(["s/0", "s/2"]);
    expect(zapper.pending()).toBe(false);
    expect(zapper.playing()?.id).toBe("s/2");

    zapper.zap(-1);
    zapper.cancelZap();
    vi.advanceTimersByTime(1000);
    expect(zapper.shown()?.id).toBe("s/2");
    expect(played).toHaveLength(2);
  });

  it("zaps through the group a channel was picked from", () => {
    vi.useFakeTimers();
    const news = { group: "News" };
    const { zapper, played } = setup([channel(0, news), channel(1), channel(2, news), channel(3)]);
    zapper.tune(channel(2, news), "News");
    zapper.zap(1);
    vi.advanceTimersByTime(400);
    expect(played).toEqual(["s/2", "s/0"]);
    expect(zapper.group()).toBe("News");
    expect(zapper.groupChannels(undefined)).toHaveLength(4);
  });

  it("picks channels by number: the playlist's, or else the position", () => {
    vi.useFakeTimers();
    const { zapper, played } = setup([channel(0, { number: 101 }), channel(1), channel(2)]);
    expect(zapper.numberOf(channel(0))).toBe(101);
    expect(zapper.numberOf(channel(2))).toBe(3);

    zapper.digit(1);
    zapper.digit(0);
    expect(zapper.digits()).toBe("10");
    zapper.digit(1);
    vi.advanceTimersByTime(2000);
    expect(played).toEqual(["s/0"]);
    expect(zapper.digits()).toBe("");

    zapper.digit(3);
    zapper.enterNumber();
    expect(played).toEqual(["s/0", "s/2"]);

    zapper.digit(9);
    zapper.enterNumber();
    expect(zapper.missing()).toBe("9");
    expect(played).toHaveLength(2);
    zapper.digit(2);
    expect(zapper.missing()).toBeUndefined();
  });

  it("follows channels that go away", () => {
    const { zapper, setChannels } = setup([channel(0), channel(1)]);
    zapper.start(false);
    setChannels([channel(1)]);
    expect(zapper.shown()).toBeUndefined();
    zapper.reset();
    expect(zapper.playing()).toBeUndefined();
  });
});
