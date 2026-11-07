import { describe, expect, it } from "vitest";
import { emptyEdits, type ChannelEdits } from "../data/channelEdits";
import type { Channel } from "../data/lineup";
import { FAVOURITES } from "./groups";
import { buildLiveView } from "./liveView";

const channel = (index: number, name: string, group?: string, number?: number): Channel => ({
  source: "s",
  id: `s/${name}`,
  index,
  name,
  url: `http://a/${index}.ts`,
  group,
  number,
});
const lineup = [
  channel(0, "News 2", "News", 12),
  channel(1, "Film", "Movies", 3),
  channel(2, "news 10", "News", 2),
  channel(3, "Kids", "Kids", 7),
  channel(4, "Loose"),
];
const find = (id: string) => lineup.find(one => one.id === id);
const view = (change: Partial<ChannelEdits> = {}) =>
  buildLiveView(lineup, find, { ...emptyEdits(), ...change });
const shape = (edits: Partial<ChannelEdits>) =>
  view(edits).groups.map(group => [group.name, ...group.channels.map(one => one.name)]);

describe("live view", () => {
  it("shows the lineup's groups as they first appear", () => {
    expect(shape({})).toEqual([
      ["News", "News 2", "news 10"],
      ["Movies", "Film"],
      ["Kids", "Kids"],
      ["", "Loose"],
    ]);
  });

  it("leaves hidden channels and hidden groups' channels out of everything", () => {
    const shown = view({
      hiddenChannels: ["s/Film"],
      hiddenGroups: ["News"],
      favourites: ["s/News 2", "s/Kids"],
    });
    expect(shown.channels.map(one => one.name)).toEqual(["Kids", "Loose"]);
    expect(shown.groups.map(group => group.name)).toEqual([FAVOURITES, "Kids", ""]);
    expect(shown.groups[0].channels.map(one => one.name)).toEqual(["Kids"]);
  });

  it("puts moved channels in their new group, and orders and sorts groups", () => {
    expect(
      shape({
        movedChannels: { "s/Kids": "\u0001mine", "s/Film": "\u0001mine" },
        groupOrder: ["\u0001mine", "", "gone"],
        groupSort: { News: "number", "\u0001mine": "name" },
      }),
    ).toEqual([
      ["\u0001mine", "Film", "Kids"],
      ["", "Loose"],
      ["News", "news 10", "News 2"],
    ]);
    expect(shape({ groupSort: { News: "name" } })[0]).toEqual(["News", "News 2", "news 10"]);
  });

  it("locks a channel, or every channel of a locked group", () => {
    const locked = view({
      lockedChannels: ["s/Loose"],
      lockedGroups: ["News"],
      movedChannels: { "s/news 10": "Kids" },
    });
    expect(lineup.filter(locked.isLocked).map(one => one.name)).toEqual(["News 2", "Loose"]);
  });
});
