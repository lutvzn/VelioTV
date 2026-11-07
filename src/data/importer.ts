// Imports a source (an M3U playlist or an Xtream account) and its XMLTV
// guides into the database, parsing as it downloads so that memory stays
// flat. It runs in a Web Worker (see
// import.worker.ts), but works on any thread.
//
// Only guide channels the playlist uses are kept, matched by tvg-id (ignoring
// case). Without a playlist, the whole guide is kept. The guide is kept
// within a storage budget; see guideWriter.ts.

import {
  DAY,
  finished,
  openDb,
  readImport,
  request,
  sourceRange,
  writeChannels,
  writeTransaction,
  type ImportState,
  type StoredGuideChannel,
} from "./db";
import { GuideWriter } from "./guideWriter";
import { M3uParser } from "./m3u";
import { readText } from "./stream";
import type { GuideChannel, PlaylistChannel } from "./types";
import { XmltvParser } from "./xmltv";
import {
  normalizeServer,
  xtreamAccount,
  xtreamGuideUrl,
  xtreamLiveChannels,
  type XtreamLogin,
} from "./xtream";

const MB = 1_048_576;
// Guide channels per write.
const GUIDE_CHANNEL_BATCH = 2000;
const PROGRESS_EVERY_MS = 250;
/**
 * The guide's share of the TV's 80 MB. The rest leaves room for channel
 * lists, other data, and space deleted records hold until the database
 * compacts.
 */
export const GUIDE_BUDGET_BYTES = 50 * MB;

interface ImportCommon {
  /** The source being imported. Its earlier data is replaced. */
  source: string;
  /**
   * Guides to import. By default, the ones an M3U playlist names (url-tvg),
   * or an Xtream account's xmltv.php.
   */
  guideUrls?: string[];
  /** Minutes from UTC for guide times with no time zone. */
  guideOffsetMinutes?: number;
  /** Days of guide to keep from today, 7 by default. */
  guideDays?: number;
  /** Days of guide to keep before today, for catch-up; 1 by default. */
  guidePastDays?: number;
  guideBudgetBytes?: number;
}

export type ImportRequest = ImportCommon &
  ({ kind?: "m3u"; playlistUrl?: string } | ({ kind: "xtream" } & XtreamLogin));

export interface ImportProgress {
  stage: "channels" | "guide";
  url: string;
  /** Bytes downloaded, before decompressing. */
  bytes: number;
  /** Content-Length, when the server sends it. */
  totalBytes?: number;
  channels: number;
  /** Guide programmes read. */
  programmes: number;
}

export interface ImportResult extends ImportState {
  guideUrls: string[];
  /** Guide programmes read, including those not kept. */
  programmesRead: number;
  /** Guide programmes for channels the playlist doesn't have. */
  unmatchedProgrammes: number;
  /** Guide programmes left out for their day, or after storing stopped. */
  skippedProgrammes: number;
  seconds: number;
}

export interface ImportOptions {
  dbName?: string;
  fetch?: typeof fetch;
  onProgress?: (progress: ImportProgress) => void;
  /** The time to count days from; now by default. */
  now?: number;
}

const download = async (fetcher: typeof fetch, url: string) => {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`${url}: empty response`);
  const length = Number(response.headers.get("Content-Length"));
  return { body: response.body, totalBytes: length > 0 ? length : undefined };
};

const putState = async (db: IDBDatabase, state: ImportState) => {
  const transaction = writeTransaction(db, "imports");
  transaction.objectStore("imports").put(state);
  await finished(transaction);
};

// Deletes what an import left from before: records it didn't write.
const deleteStale = async (
  db: IDBDatabase,
  source: string,
  guideChannels: Set<string>,
  writer: GuideWriter,
) => {
  const transaction = writeTransaction(db, ["guideChannels", "guide"]);
  const guideChannelStore = transaction.objectStore("guideChannels");
  const guideStore = transaction.objectStore("guide");
  const [guideChannelKeys, guideKeys] = await Promise.all([
    request<[string, string][]>(guideChannelStore.getAllKeys(sourceRange(source))),
    request<[string, string, number][]>(guideStore.getAllKeys(sourceRange(source))),
  ]);
  for (const key of guideChannelKeys) if (!guideChannels.has(key[1])) guideChannelStore.delete(key);
  for (const key of guideKeys) if (!writer.has(key[1], key[2])) guideStore.delete(key);
  await finished(transaction);
};

export const runImport = async (input: ImportRequest, options: ImportOptions = {}): Promise<ImportResult> => {
  const fetcher = options.fetch ?? fetch.bind(globalThis);
  const started = Date.now();
  const today = Math.floor((options.now ?? started) / DAY);
  const { source } = input;
  const db = await openDb(options.dbName);
  const state: ImportState = {
    source,
    status: "importing",
    startedAt: started,
    channels: 0,
    guideChannels: 0,
    programmes: 0,
    guideBytes: 0,
    guideFirstDay: today - (input.guidePastDays ?? 1),
    guideLastDay: today + (input.guideDays ?? 7) - 1,
    guideTrimmed: false,
  };

  let progress: ImportProgress = { stage: "channels", url: "", bytes: 0, channels: 0, programmes: 0 };
  let reported = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!options.onProgress || (!force && now - reported < PROGRESS_EVERY_MS)) return;
    reported = now;
    options.onProgress({ ...progress });
  };

  // While importing, and after a failure, the import state keeps the counts
  // of the data still stored from before.
  let previous: ImportState | undefined;
  const shownState = (status: "importing" | "failed", error?: string): ImportState => {
    const shown: ImportState = { ...(previous ?? state), status, startedAt: started };
    delete shown.finishedAt;
    delete shown.error;
    if (status === "failed") shown.finishedAt = Date.now();
    if (error !== undefined) shown.error = error;
    return shown;
  };

  try {
    previous = await readImport(db, source);
    if (previous?.lastDoneAt) state.lastDoneAt = previous.lastDoneAt;
    await putState(db, shownState("importing"));
    // The playlist's guide ids, lower-cased, to its own spelling of them.
    const guideIds = new Map<string, string>();
    let guideUrls = input.guideUrls ?? [];

    // Kept until the channel stage ends, then stored as one record.
    let channels: PlaylistChannel[] = [];
    const addChannel = (channel: PlaylistChannel) => {
      channels.push(channel);
      if (channel.guideId && !guideIds.has(channel.guideId.toLowerCase())) {
        guideIds.set(channel.guideId.toLowerCase(), channel.guideId);
      }
    };
    const countBytes = (bytes: number) => {
      progress.bytes += bytes;
      report();
    };

    if (input.kind === "xtream") {
      progress = { ...progress, url: normalizeServer(input.server) };
      const account = await xtreamAccount(input, fetcher);
      state.account = account;
      for (const channel of await xtreamLiveChannels(input, account, fetcher, countBytes))
        addChannel(channel);
      progress.channels = channels.length;
      report(true);
      if (!input.guideUrls) guideUrls = [xtreamGuideUrl(input)];
    } else if (input.playlistUrl) {
      const { body, totalBytes } = await download(fetcher, input.playlistUrl);
      progress = { ...progress, url: input.playlistUrl, totalBytes };
      const parser = new M3uParser(addChannel);
      for await (const text of readText(body, bytes => (progress.bytes += bytes))) {
        parser.push(text);
        progress.channels = parser.count;
        report();
      }
      parser.end();
      progress.channels = parser.count;
      report(true);
      if (!input.guideUrls) guideUrls = parser.guideUrls;
    }

    // Written even when empty (a guide-only import), replacing the last list.
    await writeChannels(db, source, channels);
    state.channels = channels.length;
    channels = [];

    // Without a channel list, keep the whole guide.
    const keepAll = input.kind !== "xtream" && !input.playlistUrl;
    const writer = new GuideWriter(db, {
      source,
      firstDay: state.guideFirstDay,
      lastDay: state.guideLastDay,
      budgetBytes: input.guideBudgetBytes ?? GUIDE_BUDGET_BYTES,
    });
    const kept = new Set<string>();
    let guideChannels: StoredGuideChannel[] = [];
    let unmatched = 0;
    let read = 0;
    const writeGuideChannels = async () => {
      const transaction = writeTransaction(db, "guideChannels");
      const store = transaction.objectStore("guideChannels");
      for (const channel of guideChannels) store.put(channel);
      guideChannels = [];
      await finished(transaction);
    };
    const keep = (id: string) => (keepAll ? id : guideIds.get(id.toLowerCase()));

    for (const url of guideUrls) {
      if (writer.stopped) break;
      const { body, totalBytes } = await download(fetcher, url);
      progress = { ...progress, stage: "guide", url, bytes: 0, totalBytes };
      const parser = new XmltvParser({
        defaultOffsetMinutes: input.guideOffsetMinutes,
        onChannel: (channel: GuideChannel) => {
          const id = keep(channel.id);
          if (!id || kept.has(id)) return;
          kept.add(id);
          guideChannels.push({ ...channel, id, source });
        },
        onProgramme: programme => {
          read++;
          const channel = keep(programme.channel);
          if (!channel) {
            unmatched++;
            return;
          }
          programme.channel = channel;
          writer.add(programme);
        },
      });
      for await (const text of readText(body, bytes => (progress.bytes += bytes))) {
        parser.push(text);
        if (writer.full) {
          writer.expectedChannels = kept.size;
          await writer.flush();
        }
        if (guideChannels.length >= GUIDE_CHANNEL_BATCH) await writeGuideChannels();
        progress.programmes = read;
        report();
        // Reading on would only skip everything; stop the download.
        if (writer.stopped) break;
      }
      await writer.finish();
      await writeGuideChannels();
      report(true);
    }
    await writer.finish();
    await deleteStale(db, source, kept, writer);

    const finishedAt = Date.now();
    Object.assign(state, {
      status: "done",
      finishedAt,
      lastDoneAt: finishedAt,
      guideChannels: kept.size,
      programmes: writer.programmes,
      guideBytes: writer.bytes,
      guideLastDay: writer.lastDay,
      guideTrimmed: writer.trimmed,
    });
    await putState(db, state);
    return {
      ...state,
      guideUrls,
      programmesRead: read,
      unmatchedProgrammes: unmatched,
      skippedProgrammes: writer.skipped,
      seconds: (Date.now() - started) / 1000,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message || error.name : String(error);
    await putState(db, shownState("failed", message)).catch(() => {});
    throw error;
  } finally {
    db.close();
  }
};
