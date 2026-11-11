import { describe, expect, it } from "vitest";
import { type Ordered, searchTitles, sortTitles, stableOrder } from "./hubOrder";

const names = (list: readonly Ordered[]) => list.map(one => one.name);
const title = (name: string, extra: Partial<Ordered> = {}): Ordered => ({ key: name, name, ...extra });

describe("sortTitles", () => {
  const items = [
    title("Night Train", { added: 2000, year: 2001, rating: 6.5 }),
    title("Ángel", { added: 3000, year: 1999 }),
    title("the Abyss", { year: 2010, rating: 8 }),
    title("Zebra Days", { added: 2000, year: 2001, rating: 7 }),
  ];

  it("puts the newest, the highest, or by name first, and titles without one last", () => {
    expect(names(sortTitles(items, "added"))).toEqual(["Ángel", "Night Train", "Zebra Days", "the Abyss"]);
    expect(names(sortTitles(items, "year"))).toEqual(["the Abyss", "Night Train", "Zebra Days", "Ángel"]);
    expect(names(sortTitles(items, "rating"))).toEqual(["the Abyss", "Zebra Days", "Night Train", "Ángel"]);
    // Ignoring case and accents.
    expect(names(sortTitles(items, "name"))).toEqual(["Ángel", "Night Train", "the Abyss", "Zebra Days"]);
  });

  it("keeps the list as it is when listed", () => {
    expect(sortTitles(items, "listed")).toBe(items);
  });
});

describe("stableOrder", () => {
  it("orders as a stable sort does, keeping those alike in their order", () => {
    let seed = 1;
    const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
    for (const count of [0, 1, 2, 15, 16, 17, 33, 100, 1000, 4099]) {
      for (const spread of [3, 50, count + 1]) {
        const keys = Array.from({ length: count }, () => Math.floor(random() * spread));
        const wanted = keys.map((_, i) => i);
        // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
        wanted.sort((a, b) => keys[a] - keys[b] || a - b);
        expect([...stableOrder(keys)]).toEqual(wanted);
      }
    }
  });

  it("orders names", () => {
    expect([...stableOrder(["b", "a", "c", "a"])]).toEqual([1, 3, 0, 2]);
  });

  it("leaves a list in order as it is", () => {
    const keys = Array.from({ length: 500 }, (_, i) => Math.floor(i / 7));
    expect([...stableOrder(keys)]).toEqual(keys.map((_, i) => i));
  });
});

describe("searchTitles", () => {
  const items = [
    title("Twister and the City"),
    title("City of It"),
    title("It"),
    title("It Follows"),
    title("The Red Virgin"),
  ];

  it("puts the same name first, then names starting with it, then words starting with it", () => {
    expect(names(searchTitles(items, "it"))).toEqual([
      "It",
      "It Follows",
      "City of It",
      "Twister and the City",
    ]);
    expect(names(searchTitles(items, "CITY"))).toEqual(["City of It", "Twister and the City"]);
  });

  it("finds a title by its sources' names too", () => {
    const red = items[4];
    const others = (item: Ordered) => (item === red ? ["ES - La virgen roja (2024)"] : []);
    expect(names(searchTitles(items, "virgen"))).toEqual([]);
    expect(names(searchTitles(items, "virgen", others))).toEqual(["The Red Virgin"]);
    expect(names(searchTitles(items, "red virgen", others))).toEqual([]);
  });

  it("finds nothing for nothing typed", () => {
    expect(searchTitles(items, "  ")).toEqual([]);
  });
});
