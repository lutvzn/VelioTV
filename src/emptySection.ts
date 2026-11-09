import { createEffect, createSignal, onCleanup } from "solid-js";

// Whether the section open beside the menu has nothing to move through, such
// as Live TV with no channels. The menu keeps the keys then: Right doesn't
// go into the section, and the section doesn't take them.

const [emptyBy, setEmptyBy] = createSignal<symbol | undefined>();

/** Whether the open section has nothing in it. */
export const sectionEmpty = () => emptyBy() !== undefined;

/**
 * Says, for as long as the calling page is open, when it has nothing in it.
 * Each page marks only itself, so the page going doesn't clear what the one
 * replacing it said, whichever order they come and go in.
 */
export const markEmpty = (empty: () => boolean) => {
  const page = Symbol();
  createEffect(() => {
    const now = empty();
    setEmptyBy(current => (now ? page : current === page ? undefined : current));
  });
  onCleanup(() => setEmptyBy(current => (current === page ? undefined : current)));
};
