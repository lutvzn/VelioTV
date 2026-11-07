// The app's player: one stream at a time, through the TV's playback engine
// (devices/common/player.ts). Its status is a signal for the UI. Asking for a
// new stream drops the old one, and anything the old one reports afterwards
// is ignored, so channels can change faster than they start.
//
// Closing a playing stream blocks the UI for about 200 ms on the TV (PLAN.md,
// Phase 3), so the switch waits until the UI has drawn the new status: the
// screen changes first, then pauses. Requests that arrive meanwhile replace
// each other, and only the last one opens.
//
// A live stream that ends, stalls or fails is opened again after a growing
// delay, a few times, before the player gives up (PLAN.md, Phase 3, step 4).
// Once it has played for a while again, the count starts over.
//
// While the app is hidden it closes the stream, and opens it again when the
// app comes back (suspend() and resume(), from src/player/lifecycle.ts). A
// live stream that fails while the TV is offline waits for the network
// rather than using up its tries (Phase 3, step 6).
//
// A film or recording (a stream that isn't live) can pause and seek. One
// that drops or stalls is opened again where it was, a few times; one that
// fails to start fails (PLAN.md, Phase 6, step 1).
//
// It lists the stream's audio and subtitle tracks once it starts, and picks
// the languages chosen last time, on every channel (Phase 3, step 5). On the
// TV the app draws the subtitles, from the `subtitle` signal.
//
// It also owns the video window: while a stream is chosen, the app's
// background has a hole where the video shows (src/videoWindow.ts).

import { createSignal } from "solid-js";
import {
  errorText,
  type PlaybackEngine,
  type Stream,
  type Track,
  type TrackKind,
} from "#devices/common/player";
import { sameLanguage } from "./language";
import { appStorage } from "../data/settingsCopy";
import { FULL_SCREEN, type Rect, setVideoWindow } from "../videoWindow";

export type { Stream, Track, TrackKind };

/** The languages last chosen. Subtitles are off unless `text` names one. */
export interface TrackPreferences {
  audio?: string;
  text?: string;
}

/** Where the chosen languages are kept between channels and runs. */
export interface PreferenceStore {
  load(): TrackPreferences;
  save(preferences: TrackPreferences): void;
}

export type PlayerState =
  | "idle"
  /** Opening the stream, until its first picture. */
  | "starting"
  | "playing"
  /** Waiting for data after it had started. */
  | "buffering"
  /** A film or recording, paused. */
  | "paused"
  /** A live stream failed, and will be opened again. */
  | "reconnecting"
  /** Closed while the app is hidden; resume() opens it again. */
  | "suspended"
  | "ended"
  | "failed";

export interface PlayerStatus {
  state: PlayerState;
  stream?: Stream;
  /** Why it failed, or why it is reconnecting. */
  error?: string;
  /** Milliseconds from play() to the first picture. */
  startMs?: number;
  /**
   * While reconnecting: which try this is, from 1, and how many there are.
   * Not set while it waits for the network (error OFFLINE).
   */
  attempt?: number;
  attempts?: number;
  /** Times the stream came back after failing since play(). */
  reconnects?: number;
}

export interface PlayerOptions {
  /** Gives up on a stream that shows nothing for this long. */
  startTimeoutMs?: number;
  /** A started stream that makes no progress for this long has stalled. */
  stallMs?: number;
  /** How long to wait before each try at reopening a live stream. */
  retryDelaysMs?: number[];
  /** How long a live stream must play again before the tries start over. */
  recoveredMs?: number;
  now?: () => number;
  /** Resolves once the UI has drawn a frame. */
  afterPaint?: () => Promise<void>;
  /**
   * Where the UI shows this player's video through its background
   * (src/videoWindow.ts). A second, small player (PLAN.md, Phase 7, step 3)
   * plays over the main one's, so it leaves the hole alone.
   */
  showVideo?: (rect: Rect | null) => void;
  preferences?: PreferenceStore;
}

const PREFERENCES_KEY = "tiviplayer.tracks";

/** The chosen languages, in localStorage (and its copy). */
export const storedPreferences: PreferenceStore = {
  load: () => {
    try {
      const value: unknown = JSON.parse(appStorage.getItem(PREFERENCES_KEY) ?? "{}");
      if (typeof value !== "object" || value === null) return {};
      const field = (name: string) => {
        const one: unknown = Reflect.get(value, name);
        return typeof one === "string" ? one : undefined;
      };
      return { audio: field("audio"), text: field("text") };
    } catch {
      return {};
    }
  },
  save: preferences => {
    try {
      appStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      // Full or unavailable: the choice lasts until the next channel.
    }
  },
};

/** Kept in memory only, for tests. */
const memoryPreferences = (): PreferenceStore => {
  let kept: TrackPreferences = {};
  return { load: () => kept, save: preferences => void (kept = preferences) };
};

/** The longest the player waits for the page to draw before opening a stream. */
export const PAINT_WAIT_MS = 100;

/**
 * Resolves once the page has drawn its next frame. A frame's callbacks run
 * before it is drawn, so a task queued from one runs after the drawing. A
 * hidden page draws no frames, so the wait stops after PAINT_WAIT_MS; a
 * stream opened then still gets its start timeout.
 */
export const nextPaint = () =>
  new Promise<void>(resolve => {
    const fallback = setTimeout(resolve, PAINT_WAIT_MS);
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      setTimeout(resolve, 0);
    });
  });

export const START_TIMEOUT_MS = 20_000;
// AVPlay asks again by itself when raw TS stops arriving, after about 11 s
// on the TV, so this leaves it room.
export const STALL_MS = 15_000;
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
export const RECOVERED_MS = 30_000;
/** How often a started stream is checked for progress. */
const WATCH_MS = 1000;

/** The error for a stream that needs a Referer, which no engine can send. */
export const NEEDS_REFERER = "needs-referer";
/** Errors for a stream that showed nothing in time, stopped moving, or ended. */
export const TIMEOUT = "timeout";
export const STALLED = "stalled";
export const DROPPED = "dropped";
/** A live stream waiting for the network to come back. */
export const OFFLINE = "offline";

/** How many times a film or recording that drops is opened again where it was. */
export const VOD_RETRIES = 3;

/** Failures that opening the stream again won't fix. */
const lasting = (error: string) =>
  error === NEEDS_REFERER || /NOT_SUPPORTED|INVALID_URI|UNSUPPORTED/i.test(error);

/** One play() call, across the times its stream is opened. */
interface Request {
  stream: Stream;
  requested: number;
  /** Failed opens since it last played for a while. */
  failures: number;
  reconnects: number;
  startMs?: number;
  /** Whether it has shown a picture, at any open. */
  started?: boolean;
}

/** What a status says about a request's earlier opens. */
const counts = (request: Request) => ({
  startMs: request.startMs,
  ...(request.reconnects ? { reconnects: request.reconnects } : {}),
});

// Engines can throw for tracks they don't have, or in the wrong state.
const readTracks = (active: PlaybackEngine) => {
  try {
    return active.tracks();
  } catch {
    return [];
  }
};
const select = (active: PlaybackEngine, kind: TrackKind, id: string | undefined) => {
  try {
    active.selectTrack(kind, id);
    return true;
  } catch {
    return false;
  }
};

export const createPlayer = (getEngine: () => Promise<PlaybackEngine>, options: PlayerOptions = {}) => {
  const now = options.now ?? (() => performance.now());
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const stallMs = options.stallMs ?? STALL_MS;
  const preferences = options.preferences ?? memoryPreferences();
  const showVideo = options.showVideo ?? setVideoWindow;
  const [status, setStatus] = createSignal<PlayerStatus>({ state: "idle" });
  const [tracks, setTracks] = createSignal<Track[]>([]);
  const [subtitle, setSubtitle] = createSignal<string>();
  let subtitleTimer: number | undefined;
  const clearSubtitle = () => {
    clearTimeout(subtitleTimer);
    setSubtitle(undefined);
  };
  /** Set once the engine has loaded. */
  let engine: PlaybackEngine | undefined;
  let loading: Promise<PlaybackEngine> | undefined;
  /** One per open, so a stream left behind can't change anything. */
  let session = 0;
  let rect: Rect = FULL_SCREEN;
  const timers = new Set<number>();
  let watch: number | undefined;
  let online = true;
  /** Opens the stream again once the network is back. */
  let whenOnline: (() => void) | undefined;

  const after = (ms: number, run: () => void) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      run();
    }, ms);
    timers.add(id);
    return id;
  };
  const clearTimers = () => {
    whenOnline = undefined;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    clearInterval(watch);
    watch = undefined;
  };

  const open = async (request: Request) => {
    const mine = ++session;
    clearTimers();
    const { stream } = request;
    showVideo(rect);
    setTracks([]);
    clearSubtitle();

    let paused = false;
    let active: PlaybackEngine;
    try {
      [active] = await Promise.all([(loading ??= getEngine()), (options.afterPaint ?? nextPaint)()]);
    } catch (error) {
      loading = undefined;
      if (mine === session) setStatus({ state: "failed", stream, error: errorText(error) });
      return;
    }
    if (mine !== session) return;
    engine = active;
    const opened = now();
    let started = false;
    // AVPlay lists the tracks a moment after the first picture (PLAN.md,
    // Phase 3, step 5), so the progress check tries again until it does.
    let tracksListed = false;

    const fail = (error: string) => {
      if (mine !== session) return;
      clearTimers();
      active.stop();
      setTracks([]);
      clearSubtitle();
      // Without a network every try would fail; this doesn't count as one.
      if (stream.live && !online && !lasting(error)) {
        setStatus({ state: "reconnecting", stream, error: OFFLINE, ...counts(request) });
        whenOnline = () => void open(request);
        return;
      }
      const attempt = request.failures + 1;
      // A film that played and dropped carries on where it was.
      const vod = !stream.live && request.started;
      if (vod) request.stream = { ...stream, startMs: Math.max(0, lastPosition) };
      const tries = vod ? Math.min(VOD_RETRIES, delays.length) : delays.length;
      if ((!stream.live && !vod) || lasting(error) || attempt > tries) {
        setStatus({ state: "failed", stream, error, ...counts(request) });
        return;
      }
      request.failures = attempt;
      setStatus({
        state: "reconnecting",
        stream,
        error,
        attempt,
        attempts: tries,
        ...counts(request),
      });
      after(delays[attempt - 1] ?? 0, () => {
        if (mine === session) void open(request);
      });
    };

    // A started stream that stops moving, or buffers for too long, has
    // stalled. The position only counts once it has moved, as not every
    // engine reports one for live streams.
    let position = -1;
    // Where a film was, to open it there again if it drops.
    let lastPosition = stream.startMs ?? 0;
    let moved = false;
    let progressAt = opened;
    let bufferingSince: number | undefined;
    const check = () => {
      if (!tracksListed) tracksListed = applyPreferences(active);
      const at = now();
      const current = active.position();
      if (current > 0) lastPosition = current;
      // Paused, nothing moves: it hasn't stalled.
      if (paused) {
        progressAt = at;
        return;
      }
      if (current !== position) {
        if (position >= 0) moved = true;
        position = current;
        progressAt = at;
      }
      if (bufferingSince !== undefined && at - bufferingSince >= stallMs) fail(STALLED);
      else if (bufferingSince === undefined && moved && at - progressAt >= stallMs) fail(STALLED);
    };

    after(options.startTimeoutMs ?? START_TIMEOUT_MS, () => fail(TIMEOUT));
    try {
      // Stops the stream before, as opening another would.
      if (stream.referer) throw new Error(NEEDS_REFERER);
      active.setWindow(rect);
      active.open(stream, event => {
        if (mine !== session) return;
        if (event.type === "error") return fail(event.error);
        if (event.type === "subtitle") {
          clearTimeout(subtitleTimer);
          setSubtitle(event.text || undefined);
          if (event.text) subtitleTimer = window.setTimeout(clearSubtitle, event.durationMs);
          return;
        }
        if (event.type === "ended") {
          if (stream.live) return fail(DROPPED);
          paused = false;
          clearTimers();
          setStatus({ state: "ended", stream, ...counts(request) });
          return;
        }
        if (event.type === "buffering") {
          // Before the first picture, it is still starting; paused, it stays paused.
          if (!started || paused) return;
          bufferingSince ??= now();
          setStatus({ state: "buffering", stream, ...counts(request) });
          return;
        }
        bufferingSince = undefined;
        progressAt = now();
        if (paused) return;
        if (!started) {
          started = true;
          request.started = true;
          clearTimers();
          if (request.startMs === undefined) request.startMs = Math.round(now() - request.requested);
          else request.reconnects++;
          watch = window.setInterval(check, WATCH_MS);
          tracksListed = applyPreferences(active);
          if (request.failures) {
            after(options.recoveredMs ?? RECOVERED_MS, () => {
              if (mine === session) request.failures = 0;
            });
          }
        }
        setStatus({ state: "playing", stream, ...counts(request) });
      });
    } catch (error) {
      fail(errorText(error));
    }
    controls = {
      setPaused: (value: boolean) => {
        if (mine !== session) return;
        const { state } = status();
        if (value && (state === "playing" || state === "buffering")) {
          active.setPaused(true);
          paused = true;
          bufferingSince = undefined;
          setStatus({ state: "paused", stream: request.stream, ...counts(request) });
        } else if (!value && state === "paused") {
          active.setPaused(false);
          paused = false;
          progressAt = now();
          setStatus({ state: "playing", stream: request.stream, ...counts(request) });
        }
      },
      seek: (ms: number) => {
        if (mine !== session || stream.live) return;
        active.seek(ms);
        lastPosition = ms;
        position = -1;
        moved = false;
        progressAt = now();
      },
    };
  };
  /** Pause and seek for the stream open now. */
  let controls: { setPaused: (paused: boolean) => void; seek: (ms: number) => void } | undefined;

  /** Picks the languages chosen before, once the stream lists its tracks. Returns whether it has. */
  const applyPreferences = (active: PlaybackEngine) => {
    const { audio, text } = preferences.load();
    const listed = readTracks(active);
    if (listed.length === 0) return false;
    const find = (kind: TrackKind, language: string | undefined) =>
      listed.find(track => track.kind === kind && sameLanguage(track.language, language));
    const voice = find("audio", audio);
    if (voice && !voice.selected) select(active, "audio", voice.id);
    const words = find("text", text);
    if (words && !words.selected) select(active, "text", words.id);
    setTracks(readTracks(active));
    return true;
  };

  /**
   * Plays an audio track, or shows a subtitle track (`undefined` for none),
   * and remembers its language for the next channels.
   */
  const selectTrack = (kind: TrackKind, id: string | undefined) => {
    const active = engine;
    if (!active || !["playing", "buffering"].includes(status().state)) return;
    if (!select(active, kind, id)) return;
    if (kind === "text" && id === undefined) clearSubtitle();
    const chosen = readTracks(active);
    setTracks(chosen);
    const language = id === undefined ? undefined : chosen.find(track => track.id === id)?.language;
    // A track without a language can't be found on other channels.
    if (id !== undefined && !language) return;
    preferences.save({ ...preferences.load(), [kind]: language });
  };

  const play = async (stream: Stream) => {
    setStatus({ state: "starting", stream });
    await open({ stream, requested: now(), failures: 0, reconnects: 0 });
  };

  /**
   * Closes the stream while the app is hidden, keeping it for resume(). A
   * film keeps its place.
   */
  const suspend = () => {
    const { state, stream } = status();
    if (state === "idle" || state === "suspended" || !stream) return;
    const at = engine?.position() ?? 0;
    session++;
    clearTimers();
    engine?.stop();
    setTracks([]);
    clearSubtitle();
    setStatus({ state: "suspended", stream: stream.live || at <= 0 ? stream : { ...stream, startMs: at } });
  };

  /** Opens the suspended stream again, timed from now. */
  const resume = () => {
    const { state, stream } = status();
    if (state === "suspended" && stream) void play(stream);
  };

  /** Tells the player whether the TV has a network connection. */
  const setOnline = (value: boolean) => {
    online = value;
    if (!online || !whenOnline) return;
    const reopen = whenOnline;
    whenOnline = undefined;
    reopen();
  };

  const stop = () => {
    controls = undefined;
    session++;
    clearTimers();
    engine?.stop();
    setTracks([]);
    clearSubtitle();
    setStatus({ state: "idle" });
    showVideo(null);
  };

  /** Where the video shows, in pixels of the 1920x1080 app. */
  const setWindow = (next: Rect) => {
    rect = next;
    if (status().state === "idle") return;
    showVideo(next);
    engine?.setWindow(next);
  };

  return {
    status,
    play,
    stop,
    suspend,
    resume,
    setOnline,
    setWindow,
    /** How far the stream has played, in milliseconds. */
    position: () => engine?.position() ?? 0,
    /** How long the stream is, in milliseconds, if it has a length the engine knows. */
    duration: () => engine?.duration() ?? 0,
    /** Pauses a film or recording, or plays it on. */
    setPaused: (paused: boolean) => controls?.setPaused(paused),
    /** Jumps to `ms` from the start of a film. */
    seek: (ms: number) => controls?.seek(ms),
    formats: () => engine?.formats() ?? [],
    /** The stream's audio and subtitle tracks, once it has started. */
    tracks,
    /** Lists the tracks again, for streams that add them after starting. */
    refreshTracks: () => {
      if (engine && ["playing", "buffering"].includes(status().state)) setTracks(readTracks(engine));
    },
    selectTrack,
    /** The subtitle text to draw now, if any. */
    subtitle,
    engineName: () => engine?.name,
  };
};

export type Player = ReturnType<typeof createPlayer>;
