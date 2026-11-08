// The app's sources and their imports (src/data/sourceManager.ts), their
// channels, kept in memory (src/data/lineup.ts), and the guide days read so
// far (src/data/guideCache.ts), read in a worker (src/data/guideClient.ts),
// the user's edits to channels (src/data/channelEdits.ts) and what Live TV
// shows with them (src/live/liveView.ts), and the app's settings
// (src/data/appSettings.ts), which a backup holds with the sources, where
// films were left (src/data/watched.ts) and the reminders
// (src/data/reminders.ts).

import { createEffect, createMemo, createRoot, on } from "solid-js";
import { createAppSettings } from "./data/appSettings";
import { fetchBackup, makeBackup, sendBackup, type Backup } from "./data/backup";
import { createChannelEdits } from "./data/channelEdits";
import { createGuideCache } from "./data/guideCache";
import { createGuideClient } from "./data/guideClient";
import { shownBy } from "./data/guideWanted";
import { importSource } from "./data/importClient";
import { createLineup, type Channel } from "./data/lineup";
import { createReminders } from "./data/reminders";
import { createVodLibrary } from "./data/vodLibrary";
import { createWatched } from "./data/watched";
import { matchLanguage, tvLanguages } from "./lang/languages";
import { setTwelveHour } from "./live/format";
import { groupLabel } from "./live/groups";
import { buildLiveView } from "./live/liveView";
import { channelNumbers } from "./live/zapper";
import { createSourceManager } from "./data/sourceManager";
import { appStorage, settingsCopy } from "./data/settingsCopy";
import { setLanguage } from "./translate";

export const edits = createChannelEdits({ storage: appStorage });

export const library = createSourceManager({
  importer: importSource,
  storage: appStorage,
  // The copy agreed with localStorage at this start, or put it back.
  listConfirmed: () => ["same", "restored"].includes(settingsCopy.lastRestore()?.action ?? ""),
  // Imports leave out hidden channels' guides (src/data/guideWanted.ts).
  guideFilter: () => {
    const { hiddenChannels, hiddenGroups, movedChannels } = edits.all();
    return { hiddenChannels, hiddenGroups, movedChannels };
  },
});

export const lineup = createLineup({
  // Sources turned off keep their data, but show no channels.
  sources: () => library.sources().filter(source => !source.disabled),
  stateOf: id => library.statusOf(id).state,
});

/** Every source's films and series (src/data/vodLibrary.ts). */
export const vod = createVodLibrary({
  sources: () => library.sources().filter(source => !source.disabled),
  stateOf: id => library.statusOf(id).state,
});

export const settings = createAppSettings({ storage: appStorage });
export const watched = createWatched({ storage: appStorage });
export const reminders = createReminders({ storage: appStorage });
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
    sources: library.sources(),
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
