// Imports a source (an M3U playlist or an Xtream account) and its XMLTV
// guides into the database, parsing as it downloads so that memory stays
// flat. It runs in a Web Worker (see
// import.worker.ts), but works on any thread.
//
// Which guide channels are kept, and from when, is in guideWanted.ts: only
// those the playlist uses and shows, and only their past that catch-up can
// play. The guide is kept within a storage budget; see guideWriter.ts.
//
// Sources that use the same guide addresses share one copy (db.ts), which
// keeps what any of them wants. An import doesn't download a guide again
// when the copy stored today already holds what the source wants and either
// another source imported it within the hour (two lines from one provider
// refresh together), or the server says the files haven't changed (ETag
// and Last-Modified). A copy made on another day is imported again even if
// the files are the same, as the days that keep details have moved.
//
// Films and series are kept too (vod.ts): an Xtream account's lists, or a
// playlist's entries that aren't channels. An Xtream server that won't list
// them keeps those from before.

import { channelKeys } from "./channelKey";
import {
  DAY,
  deleteOtherGenerations,
  deleteUnusedGuides,
  finished,
  guideKey,
  measureGuide,
  openDb,
  readChannels,
  readGuideIndex,
  readGuideMeta,
  readImport,
  readImports,
  writeChannels,
  writeTransaction,
  writeVod,
  type GuideMeta,
  type ImportState,
} from "./db";
import { type GuideFilter, wantAll, wantChannels, Wanted, type WantOptions } from "./guideWanted";
import { GuideWriter, RECORD_OVERHEAD } from "./guideWriter";
import { M3uParser } from "./m3u";
import { readText } from "./stream";
import type { GuideChannel, PlaylistChannel, Programme } from "./types";
import { M3uVod, xtreamVod, type Film, type Series } from "./vod";
import { XmltvParser } from "./xmltv";
import {
  normalizeServer,
  xtreamAccount,
  xtreamGuideUrl,
  xtreamLiveChannels,
  type XtreamLogin,
} from "./xtream";
import { ensureFetch } from "../polyfills/fetch";

ensureFetch();

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
/** How recently another source's import of a shared guide makes downloading it again needless. */
export const SHARED_FRESH_MS = 60 * 60_000;

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
   * Days of guide to keep before today for every channel. By default each
   * channel keeps as many as its catch-up reaches (guideWanted.ts).
   */
  guidePastDays?: number;
  guideBudgetBytes?: number;
  /** The user's hidden channels and groups, whose guides are left out. */
  guideFilter?: GuideFilter;
  /** Measures where the import's time goes (ImportResult.timing), for probes. */
  timing?: boolean;
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

/**
 * Where an import's time went, in milliseconds. The import runs on one
 * thread, so the guide stage's parts add up to it.
 */
export interface ImportTiming {
  /** The playlist or Xtream lists: downloading, parsing and storing them; the parts below. */
  channelsMs: number;
  channels: ChannelTiming;
  /** The guide, all of it; the parts below. */
  guideMs: number;
  /** Waiting for the download's next piece: the network, and the browser's gunzip. */
  downloadWaitMs: number;
  /** Turning the bytes into text, and fflate's gunzip on TVs without DecompressionStream. */
  decodeMs: number;
  /** Reading the XMLTV, not counting what is done with each programme. */
  parseMs: number;
  /** Sorting each channel's day and packing blocks: JSON and deflate. */
  packMs: number;
  /** Waiting for IndexedDB to store the blocks, merges of late programmes included. */
  storageWaitMs: number;
  /** Merging late programmes into stored blocks, inside storageWaitMs. */
  mergeMs: number;
  /** The rest: letting events run, progress, and choosing what to keep. */
  otherMs: number;
}

/** The channel stage's parts, for `timing`. */
export interface ChannelTiming {
  /** Waiting for the playlist's next piece; for Xtream, its lists, read whole. */
  downloadWaitMs: number;
  /** Reading the M3U, not counting what is done with each entry. */
  parseMs: number;
  /** Telling films and episodes from channels, and gathering them. */
  vodMs: number;
  /** Giving channels their keys (channelKeys) and choosing the guide channels wanted. */
  keysMs: number;
  /** Storing the channel list, and the films and series. */
  storeChannelsMs: number;
  storeVodMs: number;
  /** The rest: letting events run, and progress. */
  otherMs: number;
}

export interface ImportResult extends ImportState {
  guideUrls: string[];
  /** Guide programmes read, including those not kept. */
  programmesRead: number;
  /** Guide programmes for channels the playlist doesn't have. */
  unmatchedProgrammes: number;
  /** Guide programmes left out for their time, or after storing stopped. */
  skippedProgrammes: number;
  /** Why the guide wasn't downloaded, if it wasn't; see the top of this file. */
  guideSkipped?: "shared" | "unchanged";
  seconds: number;
  /** With `timing` asked for. */
  timing?: ImportTiming;
}

export interface ImportOptions {
  dbName?: string;
  fetch?: typeof fetch;
  onProgress?: (progress: ImportProgress) => void;
  /** The time to count days from; now by default. */
  now?: number;
}

const download = async (fetcher: typeof fetch, url: string, fetched?: Response) => {
  const response = fetched ?? (await fetcher(url));
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`${url}: empty response`);
  const length = Number(response.headers.get("Content-Length"));
  return { response, body: response.body, totalBytes: length > 0 ? length : undefined };
};

type Validators = GuideMeta["validators"][string];

const validatorsOf = (response: Response): Validators | undefined => {
  const etag = response.headers.get("ETag") ?? undefined;
  const lastModified = response.headers.get("Last-Modified") ?? undefined;
  if (!etag && !lastModified) return undefined;
  const validators: Validators = {};
  if (etag) validators.etag = etag;
  if (lastModified) validators.lastModified = lastModified;
  return validators;
};

/**
 * Asks whether each guide file changed since it was imported. Resolves true
 * if none did; otherwise the first changed file's response is kept in
 * `fetched`, to read it from. Those headers make a browser ask the server
 * first whether it may send them (CORS), which most servers don't answer:
 * then the guide downloads as usual.
 */
const unchanged = async (
  fetcher: typeof fetch,
  urls: readonly string[],
  validators: GuideMeta["validators"],
  fetched: Map<string, Response>,
) => {
  for (const url of urls) {
    const known = validators[url];
    const headers: Record<string, string> = {};
    if (known.etag) headers["If-None-Match"] = known.etag;
    if (known.lastModified) headers["If-Modified-Since"] = known.lastModified;
    let response: Response;
    try {
      response = await fetcher(url, { headers });
    } catch (error) {
      console.warn("Couldn't ask whether the guide changed:", error);
      return false;
    }
    if (response.status === 304) continue;
    fetched.set(url, response);
    return false;
  }
  return true;
};

const clock = () => performance.now();

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
// cut short left behind (db.ts). Its makeRoom deletes the guide stored.
const startGeneration = async (db: IDBDatabase, guide: string) => {
  const current = (await readGuideIndex(db, guide))?.generation ?? 0;
  const transaction = writeTransaction(db, "guide");
  deleteOtherGenerations(transaction.objectStore("guide"), guide, current);
  await finished(transaction);
  const makeRoom = async () => {
    if (current === 0) return false;
    const deleting = writeTransaction(db, ["guide", "guideIndex", "guides"]);
    deleting.objectStore("guideIndex").delete(guide);
    deleting.objectStore("guides").delete(guide);
    deleteOtherGenerations(deleting.objectStore("guide"), guide, current + 1);
    await finished(deleting);
    console.warn("Storage is full: deleted the old guide to make room for the new one.");
    return true;
  };
  return { generation: current + 1, makeRoom };
};

export const runImport = async (input: ImportRequest, options: ImportOptions = {}): Promise<ImportResult> => {
  // `self` rather than globalThis, which the oldest TVs lack.
  const fetcher = options.fetch ?? fetch.bind(self);
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
  const timing: ImportTiming | undefined = input.timing
    ? {
        channelsMs: 0,
        channels: {
          downloadWaitMs: 0,
          parseMs: 0,
          vodMs: 0,
          keysMs: 0,
          storeChannelsMs: 0,
          storeVodMs: 0,
          otherMs: 0,
        },
        guideMs: 0,
        downloadWaitMs: 0,
        decodeMs: 0,
        parseMs: 0,
        packMs: 0,
        storageWaitMs: 0,
        mergeMs: 0,
        otherMs: 0,
      }
    : undefined;
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
  const budgetBytes = input.guideBudgetBytes ?? GUIDE_BUDGET_BYTES;
  const wantOptions: WantOptions = {
    now: options.now ?? started,
    pastDays: input.guidePastDays,
    filter: input.guideFilter,
  };

  // Imports the guide `key` names, unless the copy stored will do; see the
  // top of this file. `own` is what this source wants of it.
  const importGuide = async (key: string, urls: string[], own: Wanted) => {
    const counts = { read: 0, unmatched: 0, skipped: 0 };
    // Time spent in writer.add() and in the writer's flush(), finish() and
    // commit(), for `timing`.
    let addMs = 0;
    let writerMs = 0;
    const timed = async (run: () => Promise<void>) => {
      if (!timing) return run();
      const from = clock();
      await run();
      writerMs += clock() - from;
    };
    const meta = await readGuideMeta(db, key);
    const index = meta && (await readGuideIndex(db, key));
    const usable =
      meta !== undefined &&
      index !== undefined &&
      meta.today === today &&
      meta.lastDay >= state.guideLastDay &&
      own.coveredBy(meta.wanted) &&
      meta.stored.guideBytes <= budgetBytes &&
      (!meta.stored.guideTrimmed || budgetBytes <= meta.budgetBytes);
    const fetched = new Map<string, Response>();
    let skipped: ImportResult["guideSkipped"];
    if (usable) {
      if (meta.importedBy !== source && started - meta.importedAt < SHARED_FRESH_MS) skipped = "shared";
      else if (urls.every(url => meta.validators[url])) {
        progress = { ...progress, stage: "guide", url: urls[0], bytes: 0 };
        report(true);
        if (await unchanged(fetcher, urls, meta.validators, fetched)) skipped = "unchanged";
      }
    }
    if (skipped && index) {
      Object.assign(state, meta?.stored, {
        guideChannels: index.channels.filter(id => own.from(id) !== undefined).length,
      });
      return { ...counts, skipped: 0, guideSkipped: skipped };
    }

    // What every source that uses this guide wants of it.
    const wanted = new Wanted();
    wanted.merge(own);
    for (const other of await readImports(db)) {
      if (other.source === source || other.guide !== key) continue;
      const list = await readChannels(db, other.source);
      if (list.length === 0) wantAll(wanted, wantOptions);
      else wantChannels(wanted, list, wantOptions);
    }
    const earliest = wanted.earliest();
    state.guideFirstDay = earliest === undefined ? today : Math.floor(earliest / DAY);

    storing = "deleting the old guide";
    const { generation, makeRoom } = await startGeneration(db, key);
    const writer = new GuideWriter(db, {
      guide: key,
      generation,
      today,
      firstDay: state.guideFirstDay,
      lastDay: state.guideLastDay,
      budgetBytes,
      keepFrom: id => wanted.from(id),
      makeRoom,
    });
    abandonGuide = () => writer.abandon();
    // The guide channels kept. Only their programmes are stored: the app
    // names channels from the playlist.
    const kept = new Set<string>();
    // Programmes come a channel at a time, so the last answer mostly does.
    let lastId: string | undefined;
    let lastKept: string | undefined;
    const keep = (id: string) => {
      if (id !== lastId) {
        lastId = id;
        lastKept = wanted.from(id) === undefined ? undefined : id.toLowerCase();
      }
      return lastKept;
    };
    const validators: GuideMeta["validators"] = {};

    for (const url of urls) {
      if (writer.stopped) break;
      storing = undefined;
      const { response, body, totalBytes } = await download(fetcher, url, fetched.get(url));
      const known = validatorsOf(response);
      if (known) validators[url] = known;
      progress = { ...progress, stage: "guide", url, bytes: 0, totalBytes };
      // Timed, a piece's programmes are added after it is read, so the clock
      // is read once a piece: on the TV, reading it for each programme took
      // a tenth of the time it measured.
      const timedProgrammes: Programme[] = [];
      const parser = new XmltvParser({
        defaultOffsetMinutes: input.guideOffsetMinutes,
        // Programmes of channels not kept go unread (parser.unwanted), and
        // what the guide writer doesn't store isn't read.
        channelOf: keep,
        skipExtras: true,
        onChannel: (channel: GuideChannel) => {
          const id = keep(channel.id);
          if (id) kept.add(id);
        },
        onProgramme: programme => {
          counts.read++;
          if (timing) timedProgrammes.push(programme);
          else writer.add(programme);
        },
      });
      const decoding = timing ? { decodeMs: 0 } : undefined;
      let bodyEnded = timing ? clock() : 0;
      for await (const text of readText(body, bytes => (progress.bytes += bytes), { timing: decoding })) {
        if (timing) {
          let from = clock();
          timing.downloadWaitMs += from - bodyEnded;
          parser.push(text);
          timing.parseMs += clock() - from;
          from = clock();
          for (let i = 0; i < timedProgrammes.length; i++) writer.add(timedProgrammes[i]);
          timedProgrammes.length = 0;
          addMs += clock() - from;
        } else parser.push(text);
        if (writer.full) {
          writer.expectedChannels = kept.size;
          storing = "storing the guide";
          await timed(() => writer.flush());
          storing = undefined;
        }
        progress.programmes = counts.read + parser.unwanted;
        progress.guide = {
          bytes: writer.bytes,
          lastDay: writer.lastDay,
          stopped: writer.stopped,
          write: writer.writeState,
        };
        report();
        await letEventsRun();
        if (timing) bodyEnded = clock();
        // Reading on would only skip everything; stop the download.
        if (writer.stopped) break;
      }
      counts.read += parser.unwanted;
      counts.unmatched += parser.unwanted;
      if (timing && decoding) {
        timing.downloadWaitMs += clock() - bodyEnded - decoding.decodeMs;
        timing.decodeMs += decoding.decodeMs;
      }
      storing = "storing the guide";
      await timed(() => writer.finish());
      report(true);
    }
    storing = "storing the guide";
    await timed(() => writer.finish());
    // When storage filled up, a batch may not have been stored: what is.
    const stored =
      writer.stopped === "quota"
        ? await measureGuide(db, key, generation)
        : {
            programmes: writer.programmes,
            bytes: writer.bytes,
            records: 0,
            lastDay: writer.storedDays?.last,
          };
    const counted: GuideMeta["stored"] = {
      guideChannels: kept.size,
      programmes: stored.programmes,
      guideBytes: stored.bytes + stored.records * RECORD_OVERHEAD,
      guideFirstDay: writer.firstDay,
      // The guide's own last day, which may be before the last day kept.
      guideLastDay: stored.lastDay ?? writer.lastDay,
      guideTrimmed: writer.trimmed,
    };
    const committing = timing ? clock() : 0;
    await writer.commit({
      guide: key,
      urls,
      importedAt: Date.now(),
      importedBy: source,
      today,
      lastDay: state.guideLastDay,
      budgetBytes,
      wanted: wanted.toMeta(),
      validators,
      stored: counted,
    });
    if (timing) {
      // commit() only waits for IndexedDB.
      timing.storageWaitMs += clock() - committing + writer.storageWaitMs;
      timing.mergeMs += writer.mergeMs;
      timing.packMs += addMs + writerMs - writer.storageWaitMs;
    }
    abandonGuide = undefined;
    let ownKept = 0;
    for (const id of kept) if (own.from(id) !== undefined) ownKept++;
    Object.assign(state, counted, { guideChannels: ownKept });
    return { ...counts, skipped: writer.skipped, guideSkipped: undefined };
  };

  try {
    previous = await readImport(db, source);
    if (previous?.lastDoneAt) state.lastDoneAt = previous.lastDoneAt;
    await putState(db, shownState("importing"));
    const channelsFrom = clock();
    const channelParts = timing?.channels;
    // Adds the time since `from` to a part of the channel stage, if timed.
    const lap = (part: keyof ChannelTiming, from: number) => {
      if (channelParts) channelParts[part] += clock() - from;
    };
    let guideUrls = input.guideUrls ?? [];

    // Kept until the channel stage ends, then stored as one record.
    let channels: PlaylistChannel[] = [];
    const addChannel = (channel: PlaylistChannel) => channels.push(channel);
    const countBytes = (bytes: number) => {
      progress.bytes += bytes;
      report();
    };
    let vod: { films: Film[]; series: Series[] } | undefined;

    if (input.kind === "xtream") {
      progress = { ...progress, url: normalizeServer(input.server) };
      let from = clock();
      const account = await xtreamAccount(input, fetcher);
      state.account = account;
      for (const channel of await xtreamLiveChannels(input, account, fetcher, countBytes))
        addChannel(channel);
      lap("downloadWaitMs", from);
      progress.channels = channels.length;
      report(true);
      from = clock();
      vod = await xtreamVod(input, fetcher).catch((error: unknown) => {
        console.error("The Xtream server didn't list its films and series:", error);
        return undefined;
      });
      lap("downloadWaitMs", from);
      if (!input.guideUrls) guideUrls = [xtreamGuideUrl(input)];
    } else if (input.playlistUrl) {
      const { body, totalBytes } = await download(fetcher, input.playlistUrl);
      progress = { ...progress, url: input.playlistUrl, totalBytes };
      const films = new M3uVod();
      const take = (channel: PlaylistChannel) => {
        if (!films.add(channel)) addChannel(channel);
      };
      // Timed, as with the guide's programmes: a piece's entries are taken
      // after it is read.
      const timedEntries: PlaylistChannel[] = [];
      const parser = new M3uParser(channelParts ? channel => timedEntries.push(channel) : take);
      const read = (push: () => void) => {
        let from = clock();
        push();
        lap("parseMs", from);
        from = clock();
        for (let i = 0; i < timedEntries.length; i++) take(timedEntries[i]);
        timedEntries.length = 0;
        lap("vodMs", from);
      };
      let bodyEnded = clock();
      for await (const text of readText(body, bytes => (progress.bytes += bytes))) {
        lap("downloadWaitMs", bodyEnded);
        read(() => parser.push(text));
        progress.channels = channels.length;
        report();
        await letEventsRun();
        bodyEnded = clock();
      }
      lap("downloadWaitMs", bodyEnded);
      read(() => parser.end());
      progress.channels = channels.length;
      report(true);
      const from = clock();
      vod = { films: films.films, series: films.allSeries() };
      lap("vodMs", from);
      if (!input.guideUrls) guideUrls = parser.guideUrls;
    }

    // Written even when empty (a guide-only import), replacing the last list.
    storing = "storing the channels";
    let from = clock();
    const keys = channelKeys(channels);
    lap("keysMs", from);
    from = clock();
    await writeChannels(db, source, channels, keys);
    lap("storeChannelsMs", from);
    state.channels = channels.length;
    from = clock();
    // Without a channel list, keep the whole guide.
    const keepAll = input.kind !== "xtream" && !input.playlistUrl;
    const own = new Wanted();
    if (keepAll) wantAll(own, wantOptions);
    else {
      wantChannels(
        own,
        channels.map((channel, i) => ({
          id: `${source}/${keys[i]}`,
          guideId: channel.guideId,
          group: channel.group,
          catchup: channel.catchup,
        })),
        wantOptions,
      );
    }
    lap("keysMs", from);
    channels = [];
    if (vod) {
      storing = "storing the films and series";
      from = clock();
      await writeVod(db, { source, ...vod });
      lap("storeVodMs", from);
      state.films = vod.films.length;
      state.series = vod.series.length;
    } else if (previous) {
      state.films = previous.films;
      state.series = previous.series;
    }

    const key = guideKey(guideUrls, input.guideOffsetMinutes);
    const guideFrom = clock();
    if (timing) {
      timing.channelsMs = guideFrom - channelsFrom;
      const c = timing.channels;
      c.otherMs =
        timing.channelsMs -
        (c.downloadWaitMs + c.parseMs + c.vodMs + c.keysMs + c.storeChannelsMs + c.storeVodMs);
    }
    const guide = key === undefined ? undefined : await importGuide(key, guideUrls, own);
    if (timing) {
      timing.guideMs = clock() - guideFrom;
      const parts =
        timing.downloadWaitMs + timing.decodeMs + timing.parseMs + timing.packMs + timing.storageWaitMs;
      timing.otherMs = timing.guideMs - parts;
    }
    if (key === undefined) {
      delete state.guide;
      Object.assign(state, { guideChannels: 0, programmes: 0, guideBytes: 0, guideTrimmed: false });
    } else state.guide = key;

    const finishedAt = Date.now();
    Object.assign(state, { status: "done", finishedAt, lastDoneAt: finishedAt });
    storing = "saving the import";
    await putState(db, state);
    // The guide this source used before, if no source uses it now.
    await deleteUnusedGuides(db).catch((error: unknown) => {
      console.error("Couldn't delete the guides no source uses:", error);
    });
    const result: ImportResult = {
      ...state,
      guideUrls,
      programmesRead: guide?.read ?? 0,
      unmatchedProgrammes: guide?.unmatched ?? 0,
      skippedProgrammes: guide?.skipped ?? 0,
      seconds: (Date.now() - started) / 1000,
    };
    if (guide?.guideSkipped) result.guideSkipped = guide.guideSkipped;
    if (timing) result.timing = timing;
    return result;
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
