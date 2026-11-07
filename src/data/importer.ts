// Imports a source (an M3U playlist or an Xtream account) and its XMLTV
// guides into the database, parsing as it downloads so that memory stays
// flat. It runs in a Web Worker (see
// import.worker.ts), but works on any thread.
//
// Only guide channels the playlist uses are kept, matched by tvg-id (ignoring
// case). Without a playlist, the whole guide is kept. The guide is kept
// within a storage budget; see guideWriter.ts.
//
// Films and series are kept too (vod.ts): an Xtream account's lists, or a
// playlist's entries that aren't channels. An Xtream server that won't list
// them keeps those from before.

import {
  DAY,
  deleteOtherGenerations,
  finished,
  measureGuide,
  openDb,
  readGuideIndex,
  readImport,
  writeChannels,
  writeTransaction,
  writeVod,
  type ImportState,
} from "./db";
import { GuideWriter, RECORD_OVERHEAD } from "./guideWriter";
import { M3uParser } from "./m3u";
import { readText } from "./stream";
import type { GuideChannel, PlaylistChannel } from "./types";
import { M3uVod, xtreamVod, type Film, type Series } from "./vod";
import { XmltvParser } from "./xmltv";
import {
  normalizeServer,
  xtreamAccount,
  xtreamGuideUrl,
  xtreamLiveChannels,
  type XtreamLogin,
} from "./xtream";

const MB = 1_048_576;
const PROGRESS_EVERY_MS = 250;
/**
 * How long parsing runs before letting the thread handle events. A download
 * that comes faster than it parses never gives the thread back, as each read
 * resolves at once; IndexedDB then can't deliver a write's events, and on the
 * TV the browser aborts the write after a minute ("Transaction timed out due
 * to inactivity"; PLAN.md, Phase 8, step 3).
 */
const YIELD_EVERY_MS = 100;
/**
 * The guide's share of the TV's 80 MB, for all sources. A refresh writes the
 * new guide beside the old one (db.ts); a source with all of this has room
 * for both beside the channel lists, and if it doesn't, the old guide goes
 * early (guideWriter.ts). A week of a 10,000-channel guide took 38 MB
 * (PLAN.md, Phase 8, step 2).
 */
export const GUIDE_BUDGET_BYTES = 40 * MB;
/** The most days of guide kept before today, for catch-up. */
const MAX_PAST_DAYS = 7;

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
  /**
   * Days of guide to keep before today, for catch-up: by default as many as
   * the channels' catch-up reaches, from 1 to 7.
   */
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
  /** The guide stored so far: its size, the last day kept, and why storing stopped. */
  guide?: { bytes: number; lastDay: number; stopped?: "budget" | "quota"; write: string };
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

// Lets the thread handle events if parsing has held it for a while.
const eventBreaks = () => {
  let last = Date.now();
  return async () => {
    if (Date.now() - last < YIELD_EVERY_MS) return;
    await new Promise(resolve => setTimeout(resolve, 0));
    last = Date.now();
  };
};

const putState = async (db: IDBDatabase, state: ImportState) => {
  const transaction = writeTransaction(db, "imports");
  transaction.objectStore("imports").put(state);
  await finished(transaction);
};

// The guide generation an import writes, after deleting any that an import
// cut short left behind (db.ts). Its makeRoom deletes the source's guide.
const startGeneration = async (db: IDBDatabase, source: string) => {
  const current = (await readGuideIndex(db, source))?.generation ?? 0;
  const transaction = writeTransaction(db, "guide");
  deleteOtherGenerations(transaction.objectStore("guide"), source, current);
  await finished(transaction);
  const makeRoom = async () => {
    if (current === 0) return false;
    const deleting = writeTransaction(db, ["guide", "guideIndex"]);
    deleting.objectStore("guideIndex").delete(source);
    deleteOtherGenerations(deleting.objectStore("guide"), source, current + 1);
    await finished(deleting);
    console.warn("Storage is full: deleted the old guide to make room for the new one.");
    return true;
  };
  return { generation: current + 1, makeRoom };
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

  const letEventsRun = eventBreaks();
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

  // What the import was storing, for the message if a write fails (network
  // and parse errors name their file).
  let storing: string | undefined;
  let abandonGuide: (() => Promise<void>) | undefined;
  try {
    previous = await readImport(db, source);
    if (previous?.lastDoneAt) state.lastDoneAt = previous.lastDoneAt;
    await putState(db, shownState("importing"));
    // The playlist's guide ids, lower-cased, to its own spelling of them.
    const guideIds = new Map<string, string>();
    let guideUrls = input.guideUrls ?? [];

    // Kept until the channel stage ends, then stored as one record.
    let channels: PlaylistChannel[] = [];
    let catchupDays = 0;
    const addChannel = (channel: PlaylistChannel) => {
      channels.push(channel);
      if (channel.catchup) catchupDays = Math.max(catchupDays, channel.catchup.days ?? 1);
      if (channel.guideId && !guideIds.has(channel.guideId.toLowerCase())) {
        guideIds.set(channel.guideId.toLowerCase(), channel.guideId);
      }
    };
    const countBytes = (bytes: number) => {
      progress.bytes += bytes;
      report();
    };
    let vod: { films: Film[]; series: Series[] } | undefined;

    if (input.kind === "xtream") {
      progress = { ...progress, url: normalizeServer(input.server) };
      const account = await xtreamAccount(input, fetcher);
      state.account = account;
      for (const channel of await xtreamLiveChannels(input, account, fetcher, countBytes))
        addChannel(channel);
      progress.channels = channels.length;
      report(true);
      vod = await xtreamVod(input, fetcher).catch((error: unknown) => {
        console.error("The Xtream server didn't list its films and series:", error);
        return undefined;
      });
      if (!input.guideUrls) guideUrls = [xtreamGuideUrl(input)];
    } else if (input.playlistUrl) {
      const { body, totalBytes } = await download(fetcher, input.playlistUrl);
      progress = { ...progress, url: input.playlistUrl, totalBytes };
      const films = new M3uVod();
      const parser = new M3uParser(channel => {
        if (!films.add(channel)) addChannel(channel);
      });
      for await (const text of readText(body, bytes => (progress.bytes += bytes))) {
        parser.push(text);
        progress.channels = channels.length;
        report();
        await letEventsRun();
      }
      parser.end();
      progress.channels = channels.length;
      report(true);
      vod = { films: films.films, series: films.allSeries() };
      if (!input.guideUrls) guideUrls = parser.guideUrls;
    }

    // Written even when empty (a guide-only import), replacing the last list.
    storing = "storing the channels";
    await writeChannels(db, source, channels);
    state.channels = channels.length;
    channels = [];
    if (vod) {
      storing = "storing the films and series";
      await writeVod(db, { source, ...vod });
      state.films = vod.films.length;
      state.series = vod.series.length;
    } else if (previous) {
      state.films = previous.films;
      state.series = previous.series;
    }
    if (input.guidePastDays === undefined) {
      state.guideFirstDay = today - Math.max(1, Math.min(MAX_PAST_DAYS, Math.ceil(catchupDays)));
    }

    // Without a channel list, keep the whole guide.
    const keepAll = input.kind !== "xtream" && !input.playlistUrl;
    storing = "deleting the old guide";
    const { generation, makeRoom } = await startGeneration(db, source);
    const writer = new GuideWriter(db, {
      source,
      generation,
      today,
      firstDay: state.guideFirstDay,
      lastDay: state.guideLastDay,
      budgetBytes: input.guideBudgetBytes ?? GUIDE_BUDGET_BYTES,
      makeRoom,
    });
    abandonGuide = () => writer.abandon();
    // The guide channels kept. Only their programmes are stored: the app
    // names channels from the playlist.
    const kept = new Set<string>();
    let unmatched = 0;
    let read = 0;
    const keep = (id: string) => (keepAll ? id : guideIds.get(id.toLowerCase()));

    for (const url of guideUrls) {
      if (writer.stopped) break;
      storing = undefined;
      const { body, totalBytes } = await download(fetcher, url);
      progress = { ...progress, stage: "guide", url, bytes: 0, totalBytes };
      const parser = new XmltvParser({
        defaultOffsetMinutes: input.guideOffsetMinutes,
        onChannel: (channel: GuideChannel) => {
          const id = keep(channel.id);
          if (id) kept.add(id);
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
          storing = "storing the guide";
          await writer.flush();
          storing = undefined;
        }
        progress.programmes = read;
        progress.guide = {
          bytes: writer.bytes,
          lastDay: writer.lastDay,
          stopped: writer.stopped,
          write: writer.writeState,
        };
        report();
        await letEventsRun();
        // Reading on would only skip everything; stop the download.
        if (writer.stopped) break;
      }
      storing = "storing the guide";
      await writer.finish();
      report(true);
    }
    storing = "storing the guide";
    await writer.finish();
    await writer.commit();
    abandonGuide = undefined;
    // When storage filled up, a batch may not have been stored: what is.
    const guide =
      writer.stopped === "quota"
        ? await measureGuide(db, source)
        : {
            programmes: writer.programmes,
            bytes: writer.bytes,
            records: 0,
            lastDay: writer.storedDays?.last,
          };

    const finishedAt = Date.now();
    Object.assign(state, {
      status: "done",
      finishedAt,
      lastDoneAt: finishedAt,
      guideChannels: kept.size,
      programmes: guide.programmes,
      guideBytes: guide.bytes + guide.records * RECORD_OVERHEAD,
      guideFirstDay: writer.firstDay,
      // The guide's own last day, which may be before the last day kept.
      guideLastDay: guide.lastDay ?? writer.lastDay,
      guideTrimmed: writer.trimmed,
    });
    storing = "saving the import";
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
    const reason = error instanceof Error ? error.message || error.name : String(error);
    const message = storing ? `${reason} (while ${storing})` : reason;
    // The guide from before stays (unless storage filled up and it went).
    await abandonGuide?.().catch(() => {});
    await putState(db, shownState("failed", message)).catch(() => {});
    throw error;
  } finally {
    db.close();
  }
};
