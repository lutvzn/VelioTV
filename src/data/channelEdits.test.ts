import { describe, expect, it } from "vitest";
import { createChannelEdits, emptyEdits, readEdits } from "./channelEdits";
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

  it("move a favourite, keeping it within the list", () => {
    const edits = createChannelEdits({ storage: memoryStorage() });
    for (const id of ["a", "b", "c", "d"]) edits.setFavourite(id, true);
    edits.moveFavourite("d", 1);
    expect(edits.favourites()).toEqual(["a", "d", "b", "c"]);
    edits.moveFavourite("a", 9);
    expect(edits.favourites()).toEqual(["d", "b", "c", "a"]);
    edits.moveFavourite("b", -1);
    expect(edits.favourites()).toEqual(["b", "d", "c", "a"]);
    edits.moveFavourite("x", 0);
    expect(edits.favourites()).toEqual(["b", "d", "c", "a"]);
  });

  it("start empty when nothing, or something unreadable, is stored", () => {
    const storage = memoryStorage();
    expect(createChannelEdits({ storage }).favourites()).toEqual([]);
    storage.setItem("tiviplayer.channelEdits", "{not json");
    expect(createChannelEdits({ storage }).favourites()).toEqual([]);
    storage.setItem("tiviplayer.channelEdits", JSON.stringify({ favourites: [1, 2] }));
    expect(createChannelEdits({ storage }).favourites()).toEqual([]);
  });

  it("hide and lock channels and groups, and keep it across a restart", () => {
    const storage = memoryStorage();
    const edits = createChannelEdits({ storage });
    edits.setChannelHidden("s/a", true);
    edits.setGroupHidden("News", true);
    edits.setChannelLocked("s/b", true);
    edits.setGroupLocked("Kids", true);
    edits.setChannelHidden("s/a", true);
    const again = createChannelEdits({ storage });
    expect(again.all()).toMatchObject({
      hiddenChannels: ["s/a"],
      hiddenGroups: ["News"],
      lockedChannels: ["s/b"],
      lockedGroups: ["Kids"],
    });
    again.setGroupHidden("News", false);
    expect(again.isGroupHidden("News")).toBe(false);
    expect(again.isChannelLocked("s/b")).toBe(true);
  });

  it("rename, make and delete groups, and move channels into them", () => {
    let count = 0;
    const edits = createChannelEdits({ storage: memoryStorage(), newKey: () => `\u0001g${++count}` });
    edits.renameGroup("News", "  World news ");
    expect(edits.groupNames()).toEqual({ News: "World news" });
    edits.renameGroup("News", "");
    expect(edits.groupNames()).toEqual({});

    const mine = edits.createGroup("Mine");
    expect(mine).toBe("\u0001g1");
    edits.renameGroup(mine, "");
    expect(edits.groupNames()[mine]).toBe("Mine");
    edits.moveChannel("s/a", mine);
    edits.moveChannel("s/b", mine);
    edits.moveChannel("s/c", "Kids");
    edits.moveChannel("s/b", undefined);
    expect(edits.movedTo("s/a")).toBe(mine);
    expect(edits.movedTo("s/b")).toBeUndefined();
    edits.setGroupOrder([mine, "Kids", mine]);
    edits.setGroupSort(mine, "name");
    edits.setGroupLocked(mine, true);
    expect(edits.groupOrder()).toEqual([mine, "Kids"]);
    expect(edits.sortOf(mine)).toBe("name");

    edits.deleteGroup(mine);
    expect(edits.all()).toMatchObject({
      customGroups: [],
      groupNames: {},
      groupOrder: ["Kids"],
      lockedGroups: [],
      groupSort: {},
      movedChannels: { "s/c": "Kids" },
    });
    edits.setGroupSort("Kids", "number");
    edits.setGroupSort("Kids", "playlist");
    expect(edits.all().groupSort).toEqual({});
  });

  it("forget a removed source's channels, and no others", () => {
    const edits = createChannelEdits({ storage: memoryStorage() });
    for (const id of ["a/1", "ab/1"]) {
      edits.setFavourite(id, true);
      edits.setChannelHidden(id, true);
      edits.setChannelLocked(id, true);
      edits.moveChannel(id, "Kids");
    }
    edits.setGroupHidden("a/1", true);
    edits.forgetSource("a");
    expect(edits.all()).toMatchObject({
      favourites: ["ab/1"],
      hiddenChannels: ["ab/1"],
      lockedChannels: ["ab/1"],
      movedChannels: { "ab/1": "Kids" },
      hiddenGroups: ["a/1"],
    });
  });

  it("read restored edits, leaving out what doesn't fit", () => {
    expect(readEdits("nope")).toEqual(emptyEdits());
    expect(
      readEdits({
        favourites: ["a", 1, "a", "b"],
        groupSort: { News: "name", Kids: "colour" },
        groupNames: { x: 2 },
      }),
    ).toEqual({ ...emptyEdits(), favourites: ["a", "b"], groupSort: { News: "name" } });
    const storage = memoryStorage();
    const edits = createChannelEdits({ storage });
    edits.replace({ ...emptyEdits(), hiddenGroups: ["News"] });
    expect(createChannelEdits({ storage }).isGroupHidden("News")).toBe(true);
  });
});
