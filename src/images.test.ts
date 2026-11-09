import { describe, expect, it } from "vitest";
import { sizedImage } from "./images";

describe("sizedImage", () => {
  const poster = "https://image.tmdb.org/t/p/original/abc123.jpg";

  it("asks TMDB for the smallest width at least as wide as drawn", () => {
    expect(sizedImage(poster, 182)).toBe("https://image.tmdb.org/t/p/w185/abc123.jpg");
    expect(sizedImage(poster, 300)).toBe("https://image.tmdb.org/t/p/w342/abc123.jpg");
    expect(sizedImage(poster, 960)).toBe("https://image.tmdb.org/t/p/w1280/abc123.jpg");
    expect(sizedImage("http://image.tmdb.org/t/p/w780/x.png", 300)).toBe(
      "http://image.tmdb.org/t/p/w342/x.png",
    );
  });

  it("keeps a smaller size the provider gave", () => {
    expect(sizedImage("https://image.tmdb.org/t/p/w154/x.jpg", 300)).toBe(
      "https://image.tmdb.org/t/p/w154/x.jpg",
    );
  });

  it("keeps the original when it's drawn wider than TMDB's sizes", () => {
    expect(sizedImage(poster, 1600)).toBe(poster);
  });

  it("leaves other addresses alone", () => {
    expect(sizedImage("http://example.com/t/p/original/x.jpg", 182)).toBe(
      "http://example.com/t/p/original/x.jpg",
    );
    expect(sizedImage(undefined, 182)).toBeUndefined();
    expect(sizedImage("", 182)).toBe("");
  });
});
