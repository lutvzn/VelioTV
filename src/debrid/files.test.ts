import { describe, expect, it } from "vitest";
import { infoHashOf, magnetOf, pickFile, type ServiceFile, type Torrent } from "./files";

const HASH = "0123456789abcdef0123456789abcdef01234567";
const file = (id: string, name: string, size: number): ServiceFile => ({ id, name, size });
const torrent = (more: Partial<Torrent> = {}): Torrent => ({ infoHash: HASH, sources: [], ...more });

describe("a torrent's file to play", () => {
  const season = [
    file("1", "Show/Show.S01E01.1080p.mkv", 900),
    file("2", "Show/Show.S01E02.1080p.mkv", 800),
    file("3", "Show/Show.S01E03.1080p.mkv", 1000),
    file("4", "Show/sample.mkv", 10),
    file("5", "Show/Show.nfo", 1),
  ];

  it("take the file the add-on named", () => {
    expect(pickFile(season, torrent({ fileIdx: 0 }), "Show.S01E02.1080p.mkv")?.id).toBe("2");
  });

  it("else the episode's by its number", () => {
    expect(pickFile(season, torrent({ season: 1, episode: 3 }))?.id).toBe("3");
    const crossed = [file("a", "Show 1x05.mp4", 5), file("b", "Show 1x06.mp4", 6)];
    expect(pickFile(crossed, torrent({ season: 1, episode: 6 }))?.id).toBe("b");
  });

  it("else the add-on's place, from 0", () => {
    expect(pickFile(season, torrent({ fileIdx: 1 }))?.id).toBe("2");
  });

  it("else the biggest video, and none without a video", () => {
    expect(pickFile(season, torrent())?.id).toBe("3");
    expect(pickFile([file("1", "readme.txt", 5)], torrent())).toBeUndefined();
    expect(pickFile([{ id: "1", name: "stream", size: 5, mime: "video/mp4" }], torrent())?.id).toBe("1");
  });
});

describe("a torrent's magnet link", () => {
  it("carry its trackers once, without DHT hints", () => {
    const link = magnetOf(
      torrent({
        sources: [
          "tracker:udp://a.invalid:80",
          "dht:" + HASH,
          "udp://a.invalid:80",
          "tracker:http://b.invalid/announce",
        ],
      }),
      "Film",
    );
    expect(link).toBe(
      `magnet:?xt=urn:btih:${HASH}&dn=Film&tr=${encodeURIComponent("udp://a.invalid:80")}&tr=${encodeURIComponent("http://b.invalid/announce")}`,
    );
  });

  it("read hex and base32 info hashes only", () => {
    expect(infoHashOf(HASH.toUpperCase())).toBe(HASH);
    expect(infoHashOf("abcdefghijklmnopqrstuvwxyz234567")).toBe("abcdefghijklmnopqrstuvwxyz234567");
    expect(infoHashOf("xyz")).toBeUndefined();
    expect(infoHashOf(5)).toBeUndefined();
  });
});
