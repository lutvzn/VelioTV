import { createEffect, createSignal, onCleanup } from "solid-js";

// Whether the section open beside the menu has nothing to move through, such
// as Live TV with no channels. The menu keeps the keys then: Right doesn't
// go into the section, and the section doesn't take them, unless the page
// offers ways to get started (signing in, adding a playlist). Those are
// drawn by the app beside the page (GetStarted), where Left and Back lead
// to the menu, so the page's own keys don't get in their way.

/** Where the page wants the ways to get started, in its own coordinates. */
export interface StartPlace {
  x: number;
  y: number;
}

interface Empty {
  page: symbol;
  start?: StartPlace;
}

const [emptyBy, setEmptyBy] = createSignal<Empty | undefined>();

/** Whether the open section has nothing in it. */
export const sectionEmpty = () => emptyBy() !== undefined;

/** Where the open, empty section offers ways to get started, if it does. */
export const startPlace = () => emptyBy()?.start;

/**
 * Says, for as long as the calling page is open, when it has nothing in it,
 * and, with `start`, where to offer ways to get started (undefined while it
 * offers none, such as while it loads). Each page marks only itself, so the
 * page going doesn't clear what the one replacing it said, whichever order
 * they come and go in.
 */
export const markEmpty = (empty: () => boolean, start?: () => StartPlace | undefined) => {
  const page = Symbol();
  createEffect(() => {
    const now = empty();
    const place = now ? start?.() : undefined;
    setEmptyBy(current => (now ? { page, start: place } : current?.page === page ? undefined : current));
  });
  onCleanup(() => setEmptyBy(current => (current?.page === page ? undefined : current)));
};
