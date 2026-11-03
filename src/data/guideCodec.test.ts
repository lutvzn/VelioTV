import { describe, expect, it } from "vitest";
import { DAY, decodeDay, encodeDay, type StoredProgramme } from "./guideCodec";
import { readText } from "./stream";

describe("encodeDay", () => {
  it("packs and unpacks a day's programmes", () => {
    const day = 20_759;
    const start = day * DAY;
    const programmes: StoredProgramme[] = [
      { start, stop: start + 1_800_000, title: "News" },
      {
        start: start + 1_800_000,
        stop: start + 5_400_000,
        title: "Film",
        subTitle: "Part 2",
        description: 'A long description, with "quotes" and é.',
        categories: ["Movie", "Drama"],
        episode: "S01E02",
        icon: "http://img/1.jpg",
        isNew: true,
      },
      // One that runs past midnight stays in the day it starts.
      { start: start + 23 * 3_600_000, stop: start + 25 * 3_600_000, title: "Late" },
    ];
    const packed = encodeDay(day, programmes);
    expect(decodeDay(day, packed)).toEqual(programmes);
    expect(packed.length).toBeLessThan(JSON.stringify(programmes).length);
  });
});

const stream = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes]).stream();
const collect = async (iterator: AsyncGenerator<string>) => {
  let out = "";
  for await (const piece of iterator) out += piece;
  return out;
};

describe("readText", () => {
  const text = `${"<tv>é😀 ".repeat(50_000)}end`;
  const gzipped = async () =>
    new Uint8Array(
      await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
    );

  it("reads plain text", async () => {
    expect(await collect(readText(stream(new TextEncoder().encode(text))))).toBe(text);
  });

  it("reads gzip, natively or with fflate, counting the compressed bytes", async () => {
    const bytes = await gzipped();
    for (const native of [true, false]) {
      let counted = 0;
      expect(await collect(readText(stream(bytes), n => (counted += n), { native }))).toBe(text);
      expect(counted).toBe(bytes.length);
    }
  });
});
