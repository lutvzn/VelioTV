import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "./memoryStorage";
import { profileStorage } from "./profiles";
import { createVodPins, VOD_PINS_KEY } from "./vodPins";

describe("Movies and Series pins", () => {
  it("keep each page's pins in the order pinned, across a restart", () => {
    const storage = memoryStorage();
    const pins = createVodPins({ storage, profile: () => undefined });
    pins.set("movies", "genre:Comedy", true);
    pins.set("movies", "genre:Action", true);
    pins.set("movies", "genre:Comedy", true);
    pins.set("series", "genre:Drama", true);
    expect(pins.of("movies")).toEqual(["genre:Comedy", "genre:Action"]);
    expect(pins.isPinned("series", "genre:Drama")).toBe(true);
    expect(pins.isPinned("series", "genre:Comedy")).toBe(false);

    const again = createVodPins({ storage, profile: () => undefined });
    again.set("movies", "genre:Comedy", false);
    expect(again.of("movies")).toEqual(["genre:Action"]);
  });

  it("are each profile's own, and leave out what doesn't fit", () => {
    const base = memoryStorage();
    const [profile, setProfile] = createSignal<string | undefined>("a");
    const pins = createVodPins({ storage: profileStorage(base, profile), profile });
    pins.set("movies", "genre:Comedy", true);
    setProfile("b");
    expect(pins.of("movies")).toEqual([]);
    setProfile("a");
    expect(pins.of("movies")).toEqual(["genre:Comedy"]);

    const odd = memoryStorage();
    odd.setItem(VOD_PINS_KEY, JSON.stringify({ movies: ["x", 2, "x"], series: "y" }));
    const read = createVodPins({ storage: odd, profile: () => undefined });
    expect(read.of("movies")).toEqual(["x"]);
    expect(read.of("series")).toEqual([]);
  });
});
