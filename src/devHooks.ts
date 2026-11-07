// Gives on-TV tests (scripts/tv-probe/) a handle on the app's own code, as
// `window.tiviplayer`, so a probe can run the real import, read back what it
// stored, add sources without typing them on the remote, and play streams.

import { onCleanup } from "solid-js";
import { channelKeys } from "./data/channelKey";
import * as db from "./data/db";
import { createGuideClient } from "./data/guideClient";
import { importSource } from "./data/importClient";
import {
  backUpTo,
  currentBackup,
  edits,
  guide,
  guideReader,
  library,
  lineup,
  liveView,
  restoreFrom,
  settings,
} from "./library";
import { player } from "./player";

const hooks: Record<string, unknown> = {
  importSource,
  db,
  library,
  lineup,
  player,
  guide,
  guideReader,
  createGuideClient,
  edits,
  channelKeys,
  settings,
  liveView,
  currentBackup,
  backUpTo,
  restoreFrom,
};

export const installDevHooks = () => Object.assign(globalThis, { tiviplayer: hooks });

/** Puts a page's own state on `window.tiviplayer` while the page is open. */
export const exposeToProbes = (name: string, value: unknown) => {
  hooks[name] = value;
  onCleanup(() => {
    if (hooks[name] === value) hooks[name] = undefined;
  });
};
