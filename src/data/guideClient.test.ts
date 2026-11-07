import { afterEach, describe, expect, it } from "vitest";
import { DAY, deleteDb, finished, type GuideDay, openDb, readGuide, writeTransaction } from "./db";
import { createGuideClient, type GuideClient } from "./guideClient";
import { encodeDay, type StoredProgramme } from "./guideCodec";

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

const store = async () => {
  const db = await openDb(DB);
  const transaction = writeTransaction(db, "guide");
  const records: GuideDay[] = [
    { source: "s", channel: "one", day, count: first.length, data: encodeDay(day, first) },
    { source: "s", channel: "one", day: day + 1, count: second.length, data: encodeDay(day + 1, second) },
  ];
  for (const record of records) transaction.objectStore("guide").put(record);
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
