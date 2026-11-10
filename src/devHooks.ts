// Gives on-TV tests (scripts/tv-probe/) a handle on the app's own code, as
// `window.velio`, so a probe can run the real import, read back what it
// stored, add sources without typing them on the remote, and play streams.

import { activeElement, type ElementNode } from "@solidtv/solid";
import { onCleanup } from "solid-js";
import nacl from "tweetnacl";
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
  isBlocked,
  library,
  lineup,
  liveView,
  reminders,
  restoreFrom,
  settings,
  vod,
  watched,
} from "./library";
import { settingsCopy } from "./data/settingsCopy";
import { handPlay } from "./play/session";
import { player, secondPlayer } from "./player";
import { $t, language } from "./translate";
import { smallVideoWindow, videoWindow } from "./videoWindow";
import { lastSaid, voiceGuideOn } from "./voiceGuide";

const hooks: Record<string, unknown> = {
  importSource,
  db,
  library,
  lineup,
  player,
  secondPlayer,
  settingsCopy,
  videoWindow,
  smallVideoWindow,
  isBlocked,
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
  vod,
  watched,
  reminders,
  handPlay,
  /** TweetNaCl, as the app's build has it, for the `sync` probe (Velio Sync, Phase 0). */
  nacl,
  /** The app's text, and the language it shows (settings.setLanguage() picks one). */
  text: $t,
  language,
  /** Whether the TV's voice guide is on, and what the app last gave it to read. */
  voiceGuide: { on: voiceGuideOn, lastSaid },
  /** What has the keys, as the path to it: each node's name or id, and its kind. */
  focusPath: () => {
    const path: string[] = [];
    for (let at: ElementNode | undefined = activeElement(); at; at = at.parent) {
      path.push(at.id ?? at.componentName ?? at._type);
    }
    return path;
  },
};

export const installDevHooks = () => Object.assign(globalThis, { velio: hooks });

/** Gives probes the renderer, to time frames and walk the scene (the `ui-perf` probe). */
export const exposeRenderer = (renderer: unknown) => {
  hooks.renderer = renderer;
};

/** Puts a page's own state on `window.velio` while the page is open. */
export const exposeToProbes = (name: string, value: unknown) => {
  hooks[name] = value;
  onCleanup(() => {
    if (hooks[name] === value) hooks[name] = undefined;
  });
};
