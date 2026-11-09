import { createSignal, onCleanup } from "solid-js";

// A section page that lays out across the whole screen, under the menu, and
// hides the menu while it says so: the TV guide while you move through its
// programmes, and Movies and Series while you move through their posters.
// The page draws whatever it puts beside the menu over itself.

interface WholeScreenPage {
  id: symbol;
  menuAway: () => boolean;
  active: () => boolean;
}

const [page, setPage] = createSignal<WholeScreenPage>();

/** Whether the open section lays out across the whole screen. */
export const wholeScreen = () => page()?.active() ?? false;

/** Whether the open section has the menu hidden. */
export const menuAway = () => wholeScreen() && (page()?.menuAway() ?? false);

/**
 * Lays the calling page out across the whole screen for as long as it's
 * open and `active()`, with the menu hidden while `away()`. While it isn't
 * active, the page lays out right of the menu as other pages do.
 */
export const useWholeScreen = (away: () => boolean, active: () => boolean = () => true) => {
  const id = Symbol();
  setPage({ id, menuAway: away, active });
  onCleanup(() => setPage(current => (current?.id === id ? undefined : current)));
};
