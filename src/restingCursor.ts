// A cursor that opens what it's on once it rests: the menu's sections, and
// the groups beside the guide and the posters. Opening one builds its page or
// rows, which stalled moving through them on the TV when everything passed
// was opened (PLAN.md, "UI performance").

import { type Accessor, batch, createEffect, createSignal, on, onCleanup } from "solid-js";
import { holding } from "./heldKey";

/** How long the cursor rests on a section or group before it opens. */
export const CURSOR_REST_MS = 250;

export interface RestingCursor {
  /** What the cursor is on: what it moved to, or what's shown. */
  at: Accessor<string>;
  /** The cursor moved to `id`; it opens once the cursor rests. */
  move: (id: string) => void;
  /** Opens what the cursor is on now, as Right or OK do; returns what it opened, if anything. */
  settle: () => string | undefined;
  /** Forgets the move, leaving the cursor on what's shown. */
  drop: () => void;
}

/**
 * `shown` is what's open; `show` opens another. When `shown` changes in
 * another way, such as from a search or a remote's key, a move waiting to
 * open is dropped.
 */
export const createRestingCursor = (shown: Accessor<string>, show: (id: string) => void): RestingCursor => {
  const [moved, setMoved] = createSignal<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // What `settle` opened, which `shown` may reach only later (the router
  // opens a page in a transition).
  let opening: string | undefined;

  const drop = () => {
    clearTimeout(timer);
    setMoved(undefined);
  };
  const settle = () => {
    const id = moved();
    drop();
    if (id === undefined || id === shown()) return undefined;
    opening = id;
    batch(() => show(id));
    return id;
  };
  // Nothing opens while a held key moves the cursor on.
  const rest = () => {
    if (holding()) timer = setTimeout(rest, CURSOR_REST_MS);
    else settle();
  };
  const move = (id: string) => {
    if (id === shown()) {
      drop();
      return;
    }
    clearTimeout(timer);
    setMoved(id);
    timer = setTimeout(rest, CURSOR_REST_MS);
  };

  createEffect(
    on(
      shown,
      id => {
        if (id === opening) opening = undefined;
        else if (id !== moved()) drop();
      },
      { defer: true },
    ),
  );
  onCleanup(drop);

  return { at: () => moved() ?? shown(), move, settle, drop };
};
