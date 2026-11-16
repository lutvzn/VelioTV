import { describe, expect, it } from "vitest";
import {
  filler,
  recordPages,
  SNAPSHOT_ITEMS,
  SNAPSHOT_MIN_CHARS,
  SNAPSHOT_MS,
  SNAPSHOT_ROWS,
  type SnapshotPage,
  snapshotRecord,
} from "./catalogSnapshot";

const page = (key: string, at = 1000, count = 3): SnapshotPage => ({
  key,
  url: `https://addon.example.invalid/${key}.json`,
  items: Array.from({ length: count }, (_, n) => ({ id: `tt${n}`, type: "movie", name: `Film ${n}` })),
  done: false,
  at,
});

describe("the kept first pages", () => {
  it("keep the fresh ones, in the catalogs' order, capped", () => {
    const now = 1000 + SNAPSHOT_MS - 1;
    const record = snapshotRecord(
      "movie",
      [page("old", 0), page("b"), page("a"), page("other")],
      ["a", "b"],
      now,
    );
    expect(record.pages.map(one => one.key)).toEqual(["a", "b", "other"]);
    const many = Array.from({ length: SNAPSHOT_ROWS + 5 }, (_, n) =>
      page(`k${n}`, 1000, SNAPSHOT_ITEMS + 10),
    );
    const capped = snapshotRecord("movie", many, [], 1000);
    expect(capped.pages).toHaveLength(SNAPSHOT_ROWS);
    expect(capped.pages[0].items).toHaveLength(SNAPSHOT_ITEMS);
  });

  it("are padded past 64 KB with text that doesn't repeat", () => {
    const small = snapshotRecord("series", [page("a")], [], 1000);
    expect(JSON.stringify(small).length).toBeGreaterThanOrEqual(SNAPSHOT_MIN_CHARS);
    expect(filler(40)).toHaveLength(40);
    expect(filler(40)).toBe(filler(40));
    expect(new Set(filler(2000).match(/.{8}/g)).size).toBeGreaterThan(240);
  });

  it("read back, leaving out pages that don't read", () => {
    const record = snapshotRecord("movie", [page("a")], [], 1000);
    expect(recordPages(JSON.parse(JSON.stringify(record))).map(one => one.key)).toEqual(["a"]);
    expect(recordPages({ pages: [{ key: 1 }, page("b")] }).map(one => one.key)).toEqual(["b"]);
    expect(recordPages(undefined)).toEqual([]);
  });
});
