import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "./memoryStorage";
import { createPlayChoices, DEFAULT_PLAY_CHOICES, PLAY_CHOICES_KEY, readPlayChoices } from "./playChoices";

describe("the playing choices", () => {
  it("read what's kept, with anything missing or unknown at its default", () => {
    expect(readPlayChoices(null)).toEqual(DEFAULT_PLAY_CHOICES);
    expect(readPlayChoices("not json")).toEqual(DEFAULT_PLAY_CHOICES);
    expect(
      readPlayChoices(
        JSON.stringify({ order: "quality", autoPlay: "sometimes", fallbacks: 4, nextCard: "60s" }),
      ),
    ).toEqual({ ...DEFAULT_PLAY_CHOICES, order: "quality", nextCard: "60s" });
  });

  it("keep a change, and follow the profile's storage", () => {
    const storage = memoryStorage();
    const [profile, setProfile] = createSignal("one");
    const store = createRoot(() => createPlayChoices({ storage, profile }));
    store.set({ autoPlay: "first", reuseLast: true });
    expect(store.choices()).toMatchObject({ autoPlay: "first", reuseLast: true });
    expect(JSON.parse(storage.getItem(PLAY_CHOICES_KEY) ?? "{}").autoPlay).toBe("first");
    storage.removeItem(PLAY_CHOICES_KEY);
    setProfile("two");
    expect(store.choices()).toEqual(DEFAULT_PLAY_CHOICES);
  });
});
