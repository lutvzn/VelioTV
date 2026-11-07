import { describe, expect, it } from "vitest";
import { createChannelEdits } from "./channelEdits";
import { memoryStorage } from "./memoryStorage";

describe("channel edits", () => {
  it("keep favourites in the order added, across a restart", () => {
    const storage = memoryStorage();
    const edits = createChannelEdits({ storage });
    edits.setFavourite("s/i:2", true);
    edits.toggleFavourite("s/i:1");
    edits.setFavourite("s/i:2", true);
    expect(edits.favourites()).toEqual(["s/i:2", "s/i:1"]);
    expect(edits.isFavourite("s/i:1")).toBe(true);

    const again = createChannelEdits({ storage });
    expect(again.favourites()).toEqual(["s/i:2", "s/i:1"]);
    again.toggleFavourite("s/i:2");
    expect(again.favourites()).toEqual(["s/i:1"]);
    expect(again.isFavourite("s/i:2")).toBe(false);
  });

  it("start empty when nothing, or something unreadable, is stored", () => {
    const storage = memoryStorage();
    expect(createChannelEdits({ storage }).favourites()).toEqual([]);
    storage.setItem("tiviplayer.channelEdits", "{not json");
    expect(createChannelEdits({ storage }).favourites()).toEqual([]);
    storage.setItem("tiviplayer.channelEdits", JSON.stringify({ favourites: [1, 2] }));
    expect(createChannelEdits({ storage }).favourites()).toEqual([]);
  });
});
