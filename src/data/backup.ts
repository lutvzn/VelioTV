// Backing up and restoring what the user set up (PLAN.md, Phase 5, step 7):
// the sources, the edits to channels and groups, and the app's settings, as
// one JSON file, with where films were left and the reminders (Phase 6). Channels and guides aren't in it: they import again from
// the sources. A backup is sent with PUT to a URL the user types, and
// restored with GET from one, such as the test server's /backup/<name>.json.
//
// The file holds the sources' logins and the parental PIN as they are, so it
// belongs on a server the user trusts.

import { readSettings, type AppSettings } from "./appSettings";
import { readEdits, type ChannelEdits } from "./channelEdits";
import { readReminders, type Reminder } from "./reminders";
import { readSources, type Source } from "./sources";
import { readWatched, type WatchedEntry } from "./watched";
import { ensureAbortController } from "../polyfills/abort";
import { ensureFetch } from "../polyfills/fetch";

ensureAbortController();
ensureFetch();

export const BACKUP_APP = "velio";
/** The app's name before Phase 8, step 6; its backups read the same. */
const OLD_BACKUP_APPS: readonly unknown[] = ["tiviplayer"];
export const BACKUP_VERSION = 1;
const TIMEOUT_MS = 20_000;

export interface Backup {
  app: typeof BACKUP_APP;
  version: typeof BACKUP_VERSION;
  savedAt: number;
  sources: Source[];
  edits: ChannelEdits;
  settings: AppSettings;
  /** Where films and episodes were left; not in backups from before Phase 6. */
  watched?: WatchedEntry[];
  reminders?: Reminder[];
}

export const makeBackup = (
  parts: {
    sources: Source[];
    edits: ChannelEdits;
    settings: AppSettings;
    watched?: WatchedEntry[];
    reminders?: Reminder[];
  },
  now = Date.now(),
): Backup => ({
  app: BACKUP_APP,
  version: BACKUP_VERSION,
  savedAt: now,
  sources: parts.sources,
  edits: parts.edits,
  settings: parts.settings,
  watched: parts.watched ?? [],
  reminders: parts.reminders ?? [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads a backup, leaving out what doesn't fit; throws if it isn't one. */
export const readBackup = (value: unknown): Backup => {
  if (!isRecord(value)) throw new Error("backup.problem.notBackup");
  const record = value;
  if (record.app !== BACKUP_APP && !OLD_BACKUP_APPS.includes(record.app))
    throw new Error("backup.problem.notBackup");
  if (record.version !== BACKUP_VERSION) throw new Error("backup.problem.version");
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    savedAt: typeof record.savedAt === "number" ? record.savedAt : 0,
    sources: readSources(record.sources),
    edits: readEdits(record.edits),
    settings: readSettings(record.settings),
    watched: readWatched(record.watched),
    reminders: readReminders(record.reminders),
  };
};

const request = async (url: string, init: RequestInit, fetcher: typeof fetch) => {
  if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error("backup.problem.url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
};

/** Sends a backup to `url` with PUT. */
export const sendBackup = async (url: string, backup: Backup, fetcher: typeof fetch = fetch) => {
  await request(
    url,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(backup) },
    fetcher,
  );
};

/** Reads a backup from `url`. */
export const fetchBackup = async (url: string, fetcher: typeof fetch = fetch) => {
  const response = await request(url, { method: "GET", cache: "no-store" }, fetcher);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("backup.problem.notBackup");
  }
  return readBackup(value);
};
