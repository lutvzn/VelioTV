import { createSignal, onCleanup } from "solid-js";

// A section page that lays out across the whole screen, under the menu, and
// hides the menu while it says so: the TV guide, while you move through its
// programmes. The page draws whatever it puts beside the menu over itself.

interface WholeScreenPage {
  id: symbol;
  menuAway: () => boolean;
}

const [page, setPage] = createSignal<WholeScreenPage>();

/** Whether the open section lays out across the whole screen. */
export const wholeScreen = () => page() !== undefined;

/** Whether the open section has the menu hidden. */
export const menuAway = () => page()?.menuAway() ?? false;

/**
 * Lays the calling page out across the whole screen for as long as it's
 * open, with the menu hidden while `away()`.
 */
export const useWholeScreen = (away: () => boolean) => {
  const id = Symbol();
  setPage({ id, menuAway: away });
  onCleanup(() => setPage(current => (current?.id === id ? undefined : current)));
};
