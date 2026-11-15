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
  addons,
  backUpTo,
  cinemeta,
  cinemetaUrl,
  setCinemetaUrl,
  wikidataUrl,
  setWikidataUrl,
  tmdbUrl,
  setTmdbUrl,
  tmdbOn,
  tmdbRequest,
  tmdbClient,
  titleMatcher,
  vodLayout,
  wikidata,
  currentBackup,
  edits,
  events,
  guide,
  guideReader,
  isBlocked,
  library,
  lineup,
  liveView,
  profiles,
  reminders,
  restoreFrom,
  settings,
  shownSources,
  sync,
  vod,
  vodPins,
  watched,
} from "./library";
import { settingsCopy } from "./data/settingsCopy";
import { mergeFilms, mergeSeries } from "./data/titles";
import { createTitleMatcher } from "./data/titleMatches";
import { createMoreMatches, MORE_AT_ONCE } from "./data/moreMatches";
import { cleanTitle, nameKey } from "./stremio/cinemeta";
import { startPairing, tvName, waitForOwner } from "./data/pairing";
import { lastOpen } from "./data/syncOpen";
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
  /** The Movies and Series groups pinned, for the `pins` probe. */
  vodPins,
  handPlay,
  /** Velio Sync (SYNC-PLAN.md): the sign-in, profiles and live updates, for the sync-signin probe. */
  sync,
  profiles,
  events,
  shownSources,
  /** The current profile's Stremio add-ons, for the `stremio` probe. */
  addons,
  /** The modern Movies and Series (PLAN.md, "Movies and Series by title"), for the `modern` probe. */
  cinemeta,
  cinemetaUrl,
  setCinemetaUrl,
  wikidataUrl,
  setWikidataUrl,
  tmdbUrl,
  setTmdbUrl,
  tmdbOn,
  /** A request to TMDB with the build's key, for the `search-speed` probe. */
  tmdbRequest,
  titleMatcher,
  /** A matcher of its own, from the same parts, for the `match-sample` probe. */
  matchParts: { createTitleMatcher, createMoreMatches, MORE_AT_ONCE, tmdb: tmdbClient, wikidata },
  vodLayout,
  /** The modern layout's joining of titles (src/data/titles.ts), to time it. */
  mergeFilms,
  mergeSeries,
  /** The names as matching cleans them, for trying other ways to match. */
  cleanTitle,
  nameKey,
  pairing: { startPairing, tvName, waitForOwner },
  /** How long the last pull took to open, in the worker and in all. */
  syncOpen: lastOpen,
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
