import { afterEach, describe, expect, it } from "vitest";
import {
  DAY,
  deleteDb,
  finished,
  type GuideBlock,
  type GuideIndex,
  type ImportState,
  openDb,
  readGuide,
  writeTransaction,
} from "./db";
import { createGuideClient, type GuideClient } from "./guideClient";
import { encodeBlock, type StoredProgramme } from "./guideCodec";

const DB = "tiviplayer-guide-test";
const HOUR = 3_600_000;
const day = 20_000;
const at = (d: number, hours: number) => d * DAY + hours * HOUR;
const show = (title: string, d: number, start: number, hours = 1): StoredProgramme => ({
  title,
  start: at(d, start),
  stop: at(d, start + hours),
});

// Two days of one channel; "Overnight" starts the first day and ends the next.
const first = [show("Evening", day, 20, 2), show("Overnight", day, 22, 4)];
const second = [
  show("Morning", day + 1, 2, 2),
  show("Noon", day + 1, 12, 1),
  { ...show("Film", day + 1, 20), description: "A film." },
];

const block = (d: number, programmes: StoredProgramme[]): GuideBlock => ({
  guide: "g",
  generation: 1,
  day: d,
  block: 0,
  channels: 1,
  count: programmes.length,
  ...encodeBlock(d, [["one", programmes]], true),
});

// Source "s" uses guide "g".
const store = async () => {
  const db = await openDb(DB);
  const transaction = writeTransaction(db, ["guide", "guideIndex", "imports"]);
  for (const record of [block(day, first), block(day + 1, second)])
    transaction.objectStore("guide").put(record);
  const index: GuideIndex = {
    guide: "g",
    generation: 1,
    channels: ["one"],
    days: { [day]: [0], [day + 1]: [0] },
  };
  transaction.objectStore("guideIndex").put(index);
  const state: ImportState = {
    source: "s",
    status: "done",
    startedAt: 0,
    channels: 1,
    guideChannels: 1,
    programmes: 5,
    guideBytes: 0,
    guideFirstDay: day,
    guideLastDay: day + 1,
    guideTrimmed: false,
    guide: "g",
  };
  transaction.objectStore("imports").put(state);
  await finished(transaction);
  return db;
};

let client: GuideClient | undefined;
let opened: IDBDatabase | undefined;
afterEach(async () => {
  client?.close();
  opened?.close();
  await deleteDb(DB);
});

describe("the guide client", () => {
  it("reads days in the worker, with the end of the day before", async () => {
    opened = await store();
    client = createGuideClient({ dbName: DB });

    const [today, tomorrow, after, none] = await Promise.all([
      client.read("s", "one", day),
      client.read("s", "one", day + 1),
      client.read("s", "one", day + 2),
      client.read("s", "two", day),
    ]);
    expect(today.map(p => p.title)).toEqual(["Evening", "Overnight"]);
    expect(tomorrow.map(p => p.title)).toEqual(["Overnight", "Morning", "Noon", "Film"]);
    expect(after).toEqual([]);
    expect(none).toEqual([]);
    // Asked for together, so one message, and each record unpacked once.
    expect(client.stats.messages).toBe(1);
    expect(client.stats.decoded).toBe(2);

    // The same as the main thread's reader, but for the details, read apart.
    const whole = await readGuide(opened, "s", "ONE", (day + 1) * DAY, (day + 2) * DAY);
    expect(tomorrow).toEqual(whole.map(({ description: _, ...grid }) => grid));
    expect(whole[3].description).toBe("A film.");
    expect(tomorrow[3].description).toBeUndefined();
    expect(await client.details("s", "One", tomorrow[3].start)).toEqual({ description: "A film." });
    expect(await client.details("s", "one", tomorrow[2].start)).toEqual({});
    expect(await client.details("s", "two", tomorrow[2].start)).toEqual({});
  });

  it("keeps unpacked days until cleared", async () => {
    opened = await store();
    client = createGuideClient({ dbName: DB });
    await client.read("s", "one", day + 1);
    expect(client.stats.decoded).toBe(2);
    await client.read("s", "one", day + 1);
    expect(client.stats.decoded).toBe(2);
    client.clear();
    await client.read("s", "one", day + 1);
    expect(client.stats.decoded).toBe(4);
  });
});
