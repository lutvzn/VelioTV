// The sources the user has added: their settings, where they are kept, and
// when each is due for a refresh.
//
// The list is kept in localStorage, apart from the imported data in
// IndexedDB: the data can always be imported again, but the list can't, and
// a full database (the TV allows 80 MB) shouldn't stop the list being saved.

import type { ImportState } from "./db";
import type { ImportRequest } from "./importer";
import { normalizeServer } from "./xtream";

export type SourceKind = "m3u" | "xtream";

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  /** An M3U playlist's URL. */
  url?: string;
  /** An Xtream server, such as "http://example.com:8080". */
  server?: string;
  username?: string;
  password?: string;
  /** Guides to use instead of the ones the playlist or server names. */
  guideUrls?: string[];
  /** How often to import the source again. */
  refreshHours: number;
  /** Turned off: kept, with its data, but out of the lineup and not refreshed. */
  disabled?: boolean;
}

/** A source's settings, as the form edits them. */
export type SourceDraft = Omit<Source, "id">;

const HOUR = 3_600_000;
export const REFRESH_CHOICES = [6, 12, 24, 48, 168];
export const DEFAULT_REFRESH_HOURS = 24;
/** How soon to try again after an import failed or was cut short. */
export const RETRY_HOURS = 1;

const STORAGE_KEY = "tiviplayer.sources";
const STORAGE_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const optionalText = (value: unknown) => (typeof value === "string" && value ? value : undefined);

// Reads one saved source, leaving out what doesn't fit.
const readSource = (value: unknown): Source | undefined => {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  if (value.kind !== "m3u" && value.kind !== "xtream") return undefined;
  const source: Source = {
    id: value.id,
    name: typeof value.name === "string" ? value.name : "",
    kind: value.kind,
    refreshHours:
      typeof value.refreshHours === "number" && value.refreshHours > 0
        ? value.refreshHours
        : DEFAULT_REFRESH_HOURS,
  };
  for (const key of ["url", "server", "username", "password"] as const) {
    const text = optionalText(value[key]);
    if (text !== undefined) source[key] = text;
  }
  if (value.disabled === true) source.disabled = true;
  if (Array.isArray(value.guideUrls)) {
    const urls = value.guideUrls.filter((url): url is string => typeof url === "string" && url !== "");
    if (urls.length > 0) source.guideUrls = urls;
  }
  return source;
};

/** Reads saved or restored sources, leaving out any that don't fit. */
export const readSources = (list: unknown): Source[] => {
  if (!Array.isArray(list)) return [];
  const ids = new Set<string>();
  return list.map(readSource).filter((source): source is Source => {
    if (!source || ids.has(source.id)) return false;
    ids.add(source.id);
    return true;
  });
};

export const loadSources = (storage: Storage): Source[] => {
  try {
    const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    return isRecord(saved) ? readSources(saved.sources) : [];
  } catch (error) {
    console.error("Couldn't read the saved sources:", error);
    return [];
  }
};

export const saveSources = (storage: Storage, sources: readonly Source[]) => {
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, sources }));
};

export const newSourceId = () =>
  `${Date.now().toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`;

const isWebUrl = (text: string) => /^https?:\/\/[^\s/]+/i.test(text);

/** Why a draft can't be saved, as a translation key, or undefined if it can. */
export const sourceProblem = (draft: SourceDraft) => {
  if (draft.kind === "m3u") {
    if (!draft.url) return "source.problem.url";
    if (!isWebUrl(draft.url)) return "source.problem.urlForm";
  } else {
    if (!draft.server) return "source.problem.server";
    if (!draft.username || !draft.password) return "source.problem.login";
  }
  if (draft.guideUrls?.some(url => !isWebUrl(url))) return "source.problem.guideForm";
  return undefined;
};

/** A name for a source the user didn't name: its server's host name. */
export const defaultSourceName = (draft: SourceDraft) => {
  const address = draft.kind === "m3u" ? draft.url : draft.server && normalizeServer(draft.server);
  try {
    return address ? new URL(address).hostname : "";
  } catch {
    return "";
  }
};

/** Splits a guide URL field, which can hold several URLs, on spaces. */
export const splitGuideUrls = (text: string) => text.split(/\s+/).filter(Boolean);

/** Whether a change to a source means its data must be imported again. */
export const changesData = (before: SourceDraft, after: SourceDraft) =>
  before.kind !== after.kind ||
  before.url !== after.url ||
  before.server !== after.server ||
  before.username !== after.username ||
  before.password !== after.password ||
  (before.guideUrls ?? []).join(" ") !== (after.guideUrls ?? []).join(" ");

export const importRequest = (source: Source, guideBudgetBytes?: number): ImportRequest => {
  const common = {
    source: source.id,
    ...(source.guideUrls ? { guideUrls: source.guideUrls } : {}),
    ...(guideBudgetBytes === undefined ? {} : { guideBudgetBytes }),
  };
  if (source.kind === "xtream") {
    return {
      ...common,
      kind: "xtream",
      server: source.server ?? "",
      username: source.username ?? "",
      password: source.password ?? "",
    };
  }
  return { ...common, kind: "m3u", playlistUrl: source.url ?? "" };
};

/**
 * Whether a source that isn't importing now needs importing: it never has
 * been, its last import is older than its refresh time, its last import was
 * cut short (the app closed during it), or it failed an hour or more ago.
 */
export const refreshDue = (source: Source, state: ImportState | undefined, now: number) => {
  if (!state || state.status === "importing") return true;
  if (state.status === "done") {
    return now - (state.lastDoneAt ?? state.finishedAt ?? 0) >= source.refreshHours * HOUR;
  }
  const tried = state.finishedAt ?? state.startedAt;
  return now - tried >= Math.min(RETRY_HOURS, source.refreshHours) * HOUR;
};

/**
 * The guide budget for importing one source, out of the total for all of
 * them: what the others leave, and at least an equal share. A source with a
 * small guide leaves the rest to the others, and one that took more shrinks
 * to its share at its next refresh if the others have grown. Until then the
 * guides can hold more than the total, by up to a share; if storage runs
 * out, the import keeps what fitted (guideWriter.ts).
 */
export const guideBudget = (total: number, sourceCount: number, othersBytes: number) =>
  Math.max(Math.floor(total / Math.max(1, sourceCount)), total - othersBytes);
