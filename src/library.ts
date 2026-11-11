// The app's sources and their imports (src/data/sourceManager.ts), their
// channels, kept in memory (src/data/lineup.ts), and the guide days read so
// far (src/data/guideCache.ts), read in a worker (src/data/guideClient.ts),
// the user's edits to channels (src/data/channelEdits.ts) and what Live TV
// shows with them (src/live/liveView.ts), and the app's settings
// (src/data/appSettings.ts), which a backup holds with the sources, where
// films were left (src/data/watched.ts) and the reminders
// (src/data/reminders.ts). Velio Sync (src/data/sync.ts) adds the account's
// lists to the sources, and its profiles (src/data/profiles.ts), each with
// its own edits, watched and reminders. Lists that are Stremio add-ons
// aren't sources: they're the profile's add-ons (src/stremio/addons.ts),
// whose films and series show in Movies and Series.

import { createEffect, createMemo, createRoot, createSignal, on, untrack } from "solid-js";
import { createAppSettings } from "./data/appSettings";
import { fetchBackup, makeBackup, sendBackup, type Backup } from "./data/backup";
import { createChannelEdits } from "./data/channelEdits";
import { createGuideCache } from "./data/guideCache";
import { createGuideClient } from "./data/guideClient";
import { shownBy } from "./data/guideWanted";
import { importSource } from "./data/importClient";
import { createLineup, type Channel } from "./data/lineup";
import { createProfiles, profileStorage } from "./data/profiles";
import { createReminders } from "./data/reminders";
import { sourcesFor, syncedSource } from "./data/sources";
import { createSync } from "./data/sync";
import { createSyncEvents } from "./data/syncEvents";
import { openInWorker } from "./data/syncOpen";
import type { DeviceView } from "./sync-core/device";
import { createVodLibrary } from "./data/vodLibrary";
import { createVodLayout } from "./data/vodLayout";
import { createVodSorts } from "./data/vodSorts";
import { createTitleMatcher, type MatchItem, type MatchStore } from "./data/titleMatches";
import { openDb, readTitleMatches, trimTitleMatches, writeTitleMatches } from "./data/db";
import { createWatched } from "./data/watched";
import { matchLanguage, tvLanguages } from "./lang/languages";
import { setTwelveHour } from "./live/format";
import { groupLabel } from "./live/groups";
import { buildLiveView } from "./live/liveView";
import { channelNumbers } from "./live/zapper";
import { createSourceManager } from "./data/sourceManager";
import { appStorage, settingsCopy } from "./data/settingsCopy";
import { setLanguage } from "./translate";
import { createAddons, type AddonList } from "./stremio/addons";
import { addonDetails } from "./stremio/vodEntries";
import { CINEMETA_URL } from "./stremio/cinemeta";
import { createWikidata, WIKIDATA_URL } from "./stremio/wikidata";
import { createTmdb, TMDB_URL } from "./stremio/tmdb";
import { createMoreMatches, MORE_AT_ONCE } from "./data/moreMatches";

/** The account's lists as sources, each with the profiles on this TV that use it; add-ons aren't. */
const syncedSources = (view: DeviceView | undefined) =>
  (view?.lists ?? [])
    .filter(list => list.kind !== "stremio")
    .map(list =>
      syncedSource(
        list,
        view?.profiles.filter(profile => profile.lists.includes(list.id)).map(profile => profile.id) ?? [],
      ),
    );

export const sync = createSync({
  storage: appStorage,
  open: openInWorker,
  onView: (view, before) => {
    profiles.viewChanged(view, before);
    void library.applySynced(syncedSources(view)).then(removed => removed.forEach(forgetSourceData));
  },
  onSignedOut: view => {
    events.stop();
    profiles.signedOut(view);
    void library.applySynced([]).then(removed => removed.forEach(forgetSourceData));
  },
});

export const profiles = createProfiles({
  storage: appStorage,
  profiles: () => (sync.signedIn() ? (sync.view()?.profiles ?? []) : []),
});

/** Storage with the current profile's own keys (src/data/profiles.ts). */
export const profileData = profileStorage(appStorage, () => profiles.currentId());

export const edits = createChannelEdits({ storage: profileData });

export const library = createSourceManager({
  importer: importSource,
  storage: appStorage,
  // The copy agreed with localStorage at this start, or put it back.
  listConfirmed: () => ["same", "restored"].includes(settingsCopy.lastRestore()?.action ?? ""),
  // The account's lists may have changed since the last check.
  beforeCheck: () => sync.pull(),
  // Imports leave out hidden channels' guides (src/data/guideWanted.ts).
  guideFilter: () => {
    const { hiddenChannels, hiddenGroups, movedChannels } = edits.all();
    return { hiddenChannels, hiddenGroups, movedChannels };
  },
});

/**
 * The sources the current profile sees: the TV's own and its account lists.
 * Sources turned off keep their data, but show no channels.
 */
export const shownSources = () =>
  sourcesFor(library.sources(), profiles.currentId()).filter(source => !source.disabled);

export const lineup = createLineup({
  sources: shownSources,
  stateOf: id => library.statusOf(id).state,
});

/** The current profile's Stremio add-ons, in the account's order, unless turned off. */
const addonLists = (): AddonList[] => {
  const view = sync.signedIn() ? sync.view() : undefined;
  const profile = view?.profiles.find(one => one.id === profiles.currentId());
  if (!view || !profile) return [];
  return view.lists
    .filter(list => list.kind === "stremio" && list.url && !list.disabled && profile.lists.includes(list.id))
    .map(list => ({ id: list.id, name: list.name, url: list.url ?? "" }));
};

/** The add-ons the current profile has (src/stremio/addons.ts). */
export const addons = createAddons({ lists: addonLists, storage: appStorage });

/** The current profile's Movies and Series layout (src/data/vodLayout.ts). */
export const vodLayout = createVodLayout({ storage: profileData, profile: () => profiles.currentId() });
/** How the current profile orders each Movies and Series group (src/data/vodSorts.ts). */
export const vodSorts = createVodSorts({ storage: profileData, profile: () => profiles.currentId() });

const CINEMETA_KEY = "velio.cinemeta";
const keptCinemeta = () => {
  try {
    return appStorage.getItem(CINEMETA_KEY) || CINEMETA_URL;
  } catch {
    return CINEMETA_URL;
  }
};
const [cinemetaUrl, setCinemetaUrlSignal] = createSignal(keptCinemeta());
export { cinemetaUrl };
/** For tests: Cinemeta at another address, such as the test server's; empty is Stremio's own. */
export const setCinemetaUrl = (url: string) => {
  try {
    if (url) appStorage.setItem(CINEMETA_KEY, url);
    else appStorage.removeItem(CINEMETA_KEY);
  } catch (error) {
    console.warn("Couldn't keep Cinemeta's address:", error);
  }
  setCinemetaUrlSignal(url || CINEMETA_URL);
};

const WIKIDATA_KEY = "velio.wikidata";
const keptWikidata = () => {
  try {
    return appStorage.getItem(WIKIDATA_KEY) || WIKIDATA_URL;
  } catch {
    return WIKIDATA_URL;
  }
};
const [wikidataUrl, setWikidataUrlSignal] = createSignal(keptWikidata());
export { wikidataUrl };
/** For tests: Wikidata's SPARQL at another address, such as the test server's; empty is Wikidata's own. */
export const setWikidataUrl = (url: string) => {
  try {
    if (url) appStorage.setItem(WIKIDATA_KEY, url);
    else appStorage.removeItem(WIKIDATA_KEY);
  } catch (error) {
    console.warn("Couldn't keep Wikidata's address:", error);
  }
  setWikidataUrlSignal(url || WIKIDATA_URL);
};
/** TMDB ids as IMDb ids, for matching titles (src/stremio/wikidata.ts). */
// Films' ids come from their provider a few a second, so a few seconds' go in one query.
export const wikidata = createWikidata({ url: () => untrack(wikidataUrl), waitMs: 5000 });

/** Cinemeta, built in while the modern layout is on (src/stremio/cinemeta.ts). */
export const cinemeta = createAddons({
  lists: () => (vodLayout.modern() ? [{ id: "cinemeta", name: "Cinemeta", url: cinemetaUrl() }] : []),
  storage: appStorage,
  storageKey: "velio.cinemeta.manifest",
});

/** Every source's films and series (src/data/vodLibrary.ts), with the add-ons' details, else Cinemeta's. */
export const vod = createVodLibrary({
  sources: shownSources,
  stateOf: id => library.statusOf(id).state,
  addons: addonDetails(addons, cinemeta),
});

let matchDb: Promise<IDBDatabase> | undefined;
const matchStore: MatchStore = {
  load: async () => readTitleMatches(await (matchDb ??= openDb())),
  save: async record => writeTitleMatches(await (matchDb ??= openDb()), record),
  trim: async (source, from) => trimTitleMatches(await (matchDb ??= openDb()), source, from),
};

/** The sources' films and series matched to Cinemeta, while the modern layout is on (src/data/titleMatches.ts). */
// The build's TMDB key, from TMDB_API_KEY in .env (vite.config.js); none in CI.
declare const __TMDB_KEY__: string | undefined;
const TMDB_KEY = typeof __TMDB_KEY__ === "string" ? __TMDB_KEY__ : "";
const TMDB_KEY_STORE = "velio.tmdb";
const keptTmdb = () => {
  try {
    return appStorage.getItem(TMDB_KEY_STORE) || TMDB_URL;
  } catch {
    return TMDB_URL;
  }
};
const [tmdbUrl, setTmdbUrlSignal] = createSignal(keptTmdb());
export { tmdbUrl };
/** For tests: TMDB at another address, such as the test server's, which needs no key; empty is TMDB's own. */
export const setTmdbUrl = (url: string) => {
  try {
    if (url) appStorage.setItem(TMDB_KEY_STORE, url);
    else appStorage.removeItem(TMDB_KEY_STORE);
  } catch (error) {
    console.warn("Couldn't keep TMDB's address:", error);
  }
  setTmdbUrlSignal(url || TMDB_URL);
};
// The build's key goes only to TMDB itself, not to a test address.
export const tmdbClient = createTmdb({
  key: () => (untrack(tmdbUrl) === TMDB_URL ? TMDB_KEY : "test"),
  url: () => untrack(tmdbUrl),
});
/** Whether TMDB is used: with the build's key, or at a test address. */
export const tmdbOn = () => TMDB_KEY !== "" || tmdbUrl() !== TMDB_URL;
/**
 * For probes (scripts/tv-probe/probes/search-speed.js): a request to TMDB
 * itself with the build's key, without the client's limit on requests at
 * once. The answer, not the key, goes back.
 */
export const tmdbRequest = (path: string) =>
  fetch(`${TMDB_URL}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(TMDB_KEY)}`);
const moreMatches = createMoreMatches({
  tmdb: () => (untrack(tmdbOn) ? tmdbClient : undefined),
  imdbOfTmdb: (type, tmdb) => wikidata.imdbOf(type, tmdb),
  details: (type, id) => cinemeta.meta(type, id),
  providerTmdb: item => {
    const film = vod.findFilm(item.key);
    return film ? vod.filmTmdb(film) : Promise.resolve(undefined);
  },
});

export const titleMatcher = createTitleMatcher({
  items: () => {
    const items: MatchItem[] = [];
    for (const film of vod.films())
      items.push({
        key: film.key,
        source: film.source,
        type: "movie",
        name: film.name,
        year: film.year,
        category: film.category,
        askTmdb: film.providerId !== undefined,
      });
    for (const show of vod.series())
      items.push({
        key: show.key,
        source: show.source,
        type: "series",
        name: show.name,
        year: show.year,
        category: show.category,
        tmdb: show.tmdb,
      });
    return items;
  },
  // Not before Cinemeta's manifest is read, so searches go to an add-on that can search.
  on: () => vodLayout.modern() && cinemeta.states().some(state => state.manifest),
  cinemetaUrl,
  search: (type, title) => cinemeta.searchOrFail(type, title),
  details: (type, id) => cinemeta.meta(type, id),
  byTmdb: moreMatches.byTmdb,
  findMore: moreMatches.findMore,
  findMoreAtOnce: MORE_AT_ONCE,
  // Cinemeta answers over HTTP/1.1, so the TV opens at most 6 connections
  // to it; 6 searches are the fastest, and one is left for the page's own
  // requests there, as for a film's details (PLAN.md, "Cinemeta's and TMDB's
  // search speed").
  concurrency: 5,
  store: matchStore,
});
if (typeof window !== "undefined") window.addEventListener("pagehide", () => void titleMatcher.flush());

export const settings = createAppSettings({ storage: appStorage });
export const watched = createWatched({ storage: profileData });
export const reminders = createReminders({ storage: profileData });

/** Forgets what was kept about a source that's gone, in the current profile. */
function forgetSourceData(id: string) {
  edits.forgetSource(id);
  watched.forgetSource(id);
}

// Another profile: its own edits, watched and reminders.
createRoot(() =>
  createEffect(
    on(
      profiles.currentId,
      () => {
        edits.reload();
        watched.reload();
        reminders.reload();
      },
      { defer: true },
    ),
  ),
);

// The one profile, with no PIN, needs no picker.
createRoot(() => createEffect(() => profiles.chooseOnly()));

/** Live updates (src/data/syncEvents.ts), while signed in and in view. */
export const events = createSyncEvents({
  site: sync.site,
  token: () => sync.saved().token,
  rev: () => sync.view()?.rev,
  pull: sync.pull,
});
const [inView, setInView] = createSignal(
  typeof document === "undefined" || document.visibilityState !== "hidden",
);
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => setInView(document.visibilityState !== "hidden"));
createRoot(() =>
  createEffect(() => {
    if (sync.signedIn() && inView()) events.start();
    else events.stop();
  }),
);
createRoot(() => createEffect(() => setTwelveHour(settings.clock() === "12h")));
createRoot(() =>
  createEffect(() => {
    const chosen = settings.language();
    setLanguage(chosen === "auto" ? matchLanguage(tvLanguages()) : chosen);
  }),
);

/** What Live TV shows, with the user's edits applied (src/live/liveView.ts). */
export const liveView = createRoot(() =>
  createMemo(() => buildLiveView(lineup.channels(), lineup.find, edits.all())),
);
/** Favourites, while there are any, then the groups, as shown. */
export const liveGroups = () => liveView().groups;
/** Whether a channel is locked and the PIN not yet entered: it doesn't play, and its programmes don't show. */
export const isBlocked = (channel: Channel) => !settings.unlocked() && liveView().isLocked(channel);
/** A group's name as shown; undefined is every channel. */
export const groupTitle = (key: string | undefined) => groupLabel(key, edits.groupNames());
/**
 * Channel numbers from the whole lineup, so hiding a channel doesn't
 * renumber the rest; a hidden channel can't be reached by its number.
 */
export const liveNumbers = createRoot(() =>
  createMemo(() => {
    const numbers = channelNumbers(lineup.channels());
    const view = liveView();
    for (const [number, channel] of numbers.byNumber)
      if (!view.isShown(channel)) numbers.byNumber.delete(number);
    return numbers;
  }),
);

/** Everything the user set up, as a backup holds it (src/data/backup.ts). */
export const currentBackup = () =>
  makeBackup({
    // The account's lists come back by signing in again.
    sources: library.sources().filter(source => !source.synced),
    edits: edits.all(),
    settings: settings.all(),
    watched: watched.all(),
    reminders: reminders.all(),
  });

/** Puts a backup's sources, edits and settings in place of the ones here; the sources then import. */
export const restoreBackup = async (backup: Backup) => {
  edits.replace(backup.edits);
  settings.replace(backup.settings);
  watched.replace(backup.watched ?? []);
  reminders.replace(backup.reminders ?? []);
  await library.replaceAll(backup.sources);
};

/** Sends a backup of everything set up here to `url`. */
export const backUpTo = (url: string) => sendBackup(url.trim(), currentBackup());

/** Reads a backup from `url` and restores it; resolves with the backup. */
export const restoreFrom = async (url: string) => {
  const backup = await fetchBackup(url.trim());
  await restoreBackup(backup);
  return backup;
};

export const guideReader = createGuideClient();
export const guide = createGuideCache({ read: guideReader.read, details: guideReader.details });

// Hidden channels' guides aren't imported, so a channel shown again imports
// its source again, for its guide (src/data/guideWanted.ts).
createRoot(() =>
  createEffect(
    on(
      edits.all,
      (next, before) => {
        if (!before) return;
        const wasShown = shownBy(before);
        const isShown = shownBy(next);
        const due = new Set<string>();
        for (const channel of lineup.channels()) {
          if (channel.guideId && !due.has(channel.source) && isShown(channel) && !wasShown(channel)) {
            due.add(channel.source);
          }
        }
        for (const id of due) library.refresh(id, true);
      },
      { defer: true },
    ),
  ),
);

// The lineup reloads a source's channels when an import of it finishes,
// which has also replaced its guide.
createRoot(() =>
  createEffect(() => {
    lineup.channels();
    guide.clear();
    guideReader.clear();
  }),
);
