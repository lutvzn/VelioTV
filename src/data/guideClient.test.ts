import { afterEach, describe, expect, it } from "vitest";
import {
  DAY,
  deleteDb,
  finished,
  type GuideBlock,
  type GuideIndex,
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
  source: "s",
  generation: 1,
  day: d,
  block: 0,
  channels: 1,
  count: programmes.length,
  data: encodeBlock(d, [["one", programmes]], true),
});

const store = async () => {
  const db = await openDb(DB);
  const transaction = writeTransaction(db, ["guide", "guideIndex"]);
  for (const record of [block(day, first), block(day + 1, second)])
    transaction.objectStore("guide").put(record);
  const index: GuideIndex = {
    source: "s",
    generation: 1,
    channels: ["one"],
    days: { [day]: [0], [day + 1]: [0] },
  };
  transaction.objectStore("guideIndex").put(index);
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
    expect(tomorrow[3].description).toBe("A film.");
    expect(after).toEqual([]);
    expect(none).toEqual([]);
    // Asked for together, so one message, and each record unpacked once.
    expect(client.stats.messages).toBe(1);
    expect(client.stats.decoded).toBe(2);

    // The same as the main thread's reader.
    expect(tomorrow).toEqual(await readGuide(opened, "s", "one", (day + 1) * DAY, (day + 2) * DAY));
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
