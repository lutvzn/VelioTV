// Picture addresses, asked for at the size they're drawn.
//
// Providers often give TMDB's "original" pictures: posters around 2000×3000
// and backdrops up to 3840×2160. The renderer decodes and uploads a picture
// at its full size, so one poster took 24 MB of texture memory, a screen of
// them went over the renderer's limit, and the uploads stalled scrolling
// (PLAN.md, "UI performance"). TMDB serves the same picture at set widths,
// so its addresses ask for the smallest one at least as wide as drawn.

const TMDB = /^(https?:\/\/image\.tmdb\.org\/t\/p\/)(original|w\d+)(\/.+)$/;
// The widths TMDB serves for posters and backdrops.
const WIDTHS = [92, 154, 185, 342, 500, 780, 1280];

/** `url`, asking for a width of at least `width` pixels where the server allows it. */
export const sizedImage = (url: string | undefined, width: number): string | undefined => {
  if (!url) return url;
  const match = TMDB.exec(url);
  if (!match) return url;
  const wanted = WIDTHS.find(one => one >= width);
  if (wanted === undefined) return url;
  const [, base, size, path] = match;
  // A smaller size given by the provider is kept.
  if (size !== "original" && Number(size.slice(1)) <= wanted) return url;
  return `${base}w${wanted}${path}`;
};
