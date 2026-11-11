import { afterEach, describe, expect, it } from "vitest";
import { deleteDb, deleteSource, openDb, readTitleMatches, trimTitleMatches, writeTitleMatches } from "./db";
import type { MatchRecord } from "./titleMatches";

const DB = "velio-db-test";

afterEach(async () => {
  await deleteDb(DB);
});

const block = (source: string, number: number): MatchRecord => ({
  source,
  block: number,
  cinemeta: "https://cinemeta.example.invalid/manifest.json",
  matches: JSON.stringify({ [`${source}/m:${number}`]: 1 }),
});
const keys = (records: MatchRecord[]) =>
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
  records.map(record => `${record.source}:${record.block ?? "before"}`).sort((a, b) => a.localeCompare(b));

describe("title matches", () => {
  it("keeps each source's blocks, and a record from before version 8 until it's trimmed", async () => {
    const db = await openDb(DB);
    // As version 7 kept them.
    const before = db.transaction("titleMatches", "readwrite");
    before.objectStore("titleMatches").put({ source: "a", cinemeta: "x", matches: { "a/m:9": 1 } });
    await new Promise(resolve => before.addEventListener("complete", resolve));
    for (const record of [block("a", 0), block("a", 1), block("a", 2), block("b", 0)])
      await writeTitleMatches(db, record);
    expect(keys(await readTitleMatches(db))).toEqual(["a:0", "a:1", "a:2", "a:before", "b:0"]);

    await trimTitleMatches(db, "a", 1);
    expect(keys(await readTitleMatches(db))).toEqual(["a:0", "b:0"]);

    await deleteSource(db, "a");
    expect(keys(await readTitleMatches(db))).toEqual(["b:0"]);
    db.close();
  });
});
