import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { ImportState } from "./db";
import { createLineup, type Lineup } from "./lineup";
import type { Source } from "./sources";
import type { StoredChannel } from "./channelList";

const source = (id: string): Source => ({
  id,
  name: id,
  kind: "m3u",
  url: `http://${id}/`,
  refreshHours: 24,
});

const state = (id: string, fields: Partial<ImportState> = {}): ImportState => ({
  source: id,
  status: "done",
  startedAt: 1,
  channels: 0,
  guideChannels: 0,
  programmes: 0,
  guideBytes: 0,
  guideFirstDay: 0,
  guideLastDay: 0,
  guideTrimmed: false,
  ...fields,
});

const channel = (from: string, index: number, name: string, group?: string): StoredChannel => ({
  source: from,
  id: `${from}/${index}`,
  index,
  name,
  url: `http://x/${index}`,
  ...(group ? { group } : {}),
});

// A source manager's signals, and stored lists that a test can change.
const setup = () => {
  const [sources, setSources] = createSignal<Source[]>([]);
  const [states, setStates] = createSignal<Record<string, ImportState>>({});
  const stored: Record<string, StoredChannel[]> = {};
  const reads: string[] = [];
  const lineup = createLineup({
    sources,
    stateOf: id => states()[id],
    read: id => {
      reads.push(id);
      return Promise.resolve(stored[id] ?? []);
    },
  });
  return { lineup, setSources, setStates, stored, reads };
};

// Lets the reads started by an effect finish.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let lineup: Lineup | undefined;
afterEach(async () => {
  await lineup?.close();
  lineup = undefined;
});

describe("the lineup", () => {
  it("holds every source's channels, in source order, by group and by id", async () => {
    const t = setup();
    lineup = t.lineup;
    t.stored.a = [channel("a", 0, "A1", "News"), channel("a", 1, "A2")];
    t.stored.b = [channel("b", 0, "B1", "Sport"), channel("b", 1, "B2", "News")];
    t.setSources([source("b"), source("a")]);
    t.setStates({ a: state("a"), b: state("b") });
    await settle();

    expect(t.lineup.channels().map(c => c.id)).toEqual(["b/0", "b/1", "a/0", "a/1"]);
    expect(t.lineup.groups().map(g => [g.name, g.channels.map(c => c.name)])).toEqual([
      ["Sport", ["B1"]],
      ["News", ["B2", "A1"]],
      ["", ["A2"]],
    ]);
    expect(t.lineup.find("a/1")).toMatchObject({ name: "A2", source: "a", index: 1 });
    expect(t.lineup.loading()).toBe(false);
    expect(t.reads).toHaveLength(2);
    expect(new Set(t.reads)).toEqual(new Set(["a", "b"]));
  });

  it("reads a source again when an import of it finishes, and only then", async () => {
    const t = setup();
    lineup = t.lineup;
    t.stored.a = [channel("a", 0, "Old")];
    t.setSources([source("a")]);
    t.setStates({ a: state("a", { startedAt: 1 }) });
    await settle();

    // A new import starts: the old list stays.
    t.stored.a = [channel("a", 0, "New")];
    t.setStates({ a: state("a", { status: "importing", startedAt: 2 }) });
    await settle();
    expect(t.lineup.channels().map(c => c.name)).toEqual(["Old"]);

    t.setStates({ a: state("a", { status: "done", startedAt: 2 }) });
    await settle();
    expect(t.lineup.channels().map(c => c.name)).toEqual(["New"]);
    // A failed import may have replaced the list before failing.
    t.setStates({ a: state("a", { status: "failed", startedAt: 3 }) });
    await settle();
    expect(t.reads).toEqual(["a", "a", "a"]);
  });

  it("reads what an import cut short left behind", async () => {
    const t = setup();
    lineup = t.lineup;
    t.stored.a = [channel("a", 0, "Kept")];
    t.setSources([source("a")]);
    t.setStates({ a: state("a", { status: "importing" }) });
    await settle();
    expect(t.lineup.channels().map(c => c.name)).toEqual(["Kept"]);
  });

  it("drops a removed source's channels", async () => {
    const t = setup();
    lineup = t.lineup;
    t.stored.a = [channel("a", 0, "A")];
    t.stored.b = [channel("b", 0, "B")];
    t.setSources([source("a"), source("b")]);
    t.setStates({ a: state("a"), b: state("b") });
    await settle();
    t.setSources([source("b")]);
    t.setStates({ b: state("b") });
    await settle();
    expect(t.lineup.channels().map(c => c.name)).toEqual(["B"]);
    expect(t.lineup.find("a/0")).toBeUndefined();
  });
});
