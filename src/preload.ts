// Warms what a section's page shows first, while the menu's cursor rests on
// it and before OK opens it (PLAN.md, "Menu opens on OK"): the first posters
// of Movies and Series are fetched into the browser's cache, so the page
// draws them without waiting for the network. The page itself still builds
// on OK; the lists are already in memory (src/data/vodLibrary.ts).

import { sizedImage } from "./images";
import { vod } from "./library";

/** How many posters to fetch: about two screens of the grid. */
const POSTERS = 24;
/** The width a poster is drawn at (src/pages/vod/VodHub.tsx). */
const POSTER_WIDTH = 182;

const warmed = new Set<string>();
// Held, so the browser doesn't drop a fetch that's still going.
const pending: HTMLImageElement[] = [];

const warmPosters = (posters: (string | undefined)[]) => {
  for (const poster of posters.slice(0, POSTERS)) {
    const src = sizedImage(poster, POSTER_WIDTH);
    if (!src || warmed.has(src)) continue;
    warmed.add(src);
    const image = new Image();
    const done = () => {
      const at = pending.indexOf(image);
      if (at >= 0) pending.splice(at, 1);
    };
    image.addEventListener("load", done);
    image.addEventListener("error", done);
    pending.push(image);
    image.src = src;
  }
};

/** Warms the page at `path`, if it has anything to warm. */
export const warmSection = (path: string) => {
  if (path === "/movies") warmPosters(vod.films().map(film => film.poster));
  else if (path === "/series") warmPosters(vod.series().map(show => show.poster));
};
