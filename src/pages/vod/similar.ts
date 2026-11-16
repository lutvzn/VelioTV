// What "More like this" asks TMDB about a title (src/data/moreLikeThis.ts).

import type { StremioTitle } from "../../data/vodLibrary";

/** A title's IMDb id: the one it was matched to, or its add-on id when that is one. */
export const imdbOfTitle = (title: { imdb?: string; stremio?: StremioTitle }) => {
  if (title.imdb) return title.imdb;
  const id = title.stremio?.id ?? "";
  return /^tt\d+$/.test(id) ? id : undefined;
};
