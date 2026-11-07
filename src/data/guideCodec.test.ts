import { describe, expect, it } from "vitest";
import { BlockEncoder, DAY, decodeBlock, encodeBlock, type StoredProgramme } from "./guideCodec";
import { readText } from "./stream";

describe("guide blocks", () => {
  const day = 20_759;
  const start = day * DAY;
  const programmes: StoredProgramme[] = [
    { start: start + 600_000, stop: start + 1_800_000, title: "News" },
    {
      start: start + 1_800_000,
      stop: start + 5_400_000,
      title: "Film",
      subTitle: "Part 2",
      description: 'A long description, with "quotes" and é.',
      episode: "S01E02",
    },
    // A gap before it, and it runs past midnight, staying in the day it starts.
    { start: start + 23 * 3_600_000, stop: start + 25 * 3_600_000, title: "Late" },
  ];

  it("packs and unpacks channels' days", () => {
    const other = [{ start, stop: start + 3_600_000, title: "Other" }];
    const packed = encodeBlock(
      day,
      [
        ["one", programmes],
        ["two", other],
      ],
      true,
    );
    expect(decodeBlock(day, packed.data, packed.details)).toEqual(
      new Map([
        ["one", programmes],
        ["two", other],
      ]),
    );
    expect(packed.data.length + (packed.details?.length ?? 0)).toBeLessThan(
      JSON.stringify(programmes).length,
    );
  });

  it("unpacks the grid alone, without subtitles and descriptions", () => {
    const packed = encodeBlock(day, [["one", programmes]], true);
    expect(decodeBlock(day, packed.data).get("one")).toEqual(
      programmes.map(({ subTitle: _s, description: _d, ...grid }) => grid),
    );
  });

  it("leaves out subtitles and descriptions when asked, keeping episodes", () => {
    const packed = encodeBlock(day, [["one", programmes]], false);
    expect(packed.details).toBeUndefined();
    expect(decodeBlock(day, packed.data).get("one")?.[1]).toEqual({
      start: start + 1_800_000,
      stop: start + 5_400_000,
      title: "Film",
      episode: "S01E02",
    });
  });

  it("merges a channel that comes in parts, in start order", () => {
    const encoder = new BlockEncoder(day, true);
    encoder.add("one", programmes.slice(1));
    encoder.add("two", programmes.slice(0, 1));
    encoder.add("one", programmes.slice(0, 1));
    const { data, details } = encoder.finish();
    const unpacked = decodeBlock(day, data, details);
    expect(unpacked.get("one")).toEqual(programmes);
    expect(unpacked.get("two")).toEqual(programmes.slice(0, 1));
    expect(encoder.programmes).toBe(4);
  });

  it("packs an empty block", () => {
    const { data, details } = new BlockEncoder(day, true).finish();
    expect(decodeBlock(day, data, details)).toEqual(new Map());
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
