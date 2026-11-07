import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayRect, EngineEvent, PlaybackEngine, Stream, Track } from "#devices/common/player";
import { setVideoWindow, videoWindow } from "../videoWindow";
import {
  createPlayer,
  DROPPED,
  NEEDS_REFERER,
  nextPaint,
  OFFLINE,
  PAINT_WAIT_MS,
  STALLED,
  type TrackPreferences,
} from "./player";

// An engine that records what it is asked, and lets a test send its events.
const fakeEngine = () => {
  const opened: { stream: Stream; send: (event: EngineEvent) => void }[] = [];
  const windows: DisplayRect[] = [];
  let stops = 0;
  let position = 0;
  const duration = 360_000;
  const calls: string[] = [];
  // Each stream gets a fresh copy, with its first tracks selected.
  let streamTracks: Track[] = [];
  let tracks: Track[] = [];
  const selected: string[] = [];
  const engine: PlaybackEngine = {
    name: "fake",
    open: (stream, onEvent) => {
      if (stream.url === "bad") throw new Error("bad URL");
      opened.push({ stream, send: onEvent });
      tracks = streamTracks.map(track => ({ ...track }));
    },
    stop: () => stops++,
    setWindow: rect => windows.push(rect),
    position: () => position,
    duration: () => duration,
    setPaused: value => calls.push(value ? "pause" : "play"),
    seek: ms => calls.push(`seek ${ms}`),
    formats: () => [],
    tracks: () => tracks.map(track => ({ ...track })),
    selectTrack: (kind, id) => {
      selected.push(`${kind} ${id ?? "off"}`);
      for (const track of tracks) if (track.kind === kind) track.selected = track.id === id;
    },
  };
  const last = () => opened[opened.length - 1];
  return {
    engine,
    opened,
    last,
    windows,
    stops: () => stops,
    setPosition: (ms: number) => void (position = ms),
    calls,
    setTracks: (list: Track[]) => void (streamTracks = list),
    /** Tracks the open stream lists only now. */
    addTracks: (list: Track[]) => void tracks.push(...list.map(track => ({ ...track }))),
    selected,
  };
};

const PREVIEW = { x: 100, y: 100, width: 960, height: 540 };
let time = 0;
const now = () => time;
// Switches at once, as if the UI had already drawn.
const afterPaint = () => Promise.resolve();

afterEach(() => {
  vi.useRealTimers();
  setVideoWindow(null);
  time = 0;
});

const live = { url: "live", live: true };

// Moves the clock and the timers together.
const wait = async (ms: number) => {
  time += ms;
  await vi.advanceTimersByTimeAsync(ms);
};

const liveSetup = () => {
  vi.useFakeTimers();
  const fake = fakeEngine();
  const player = createPlayer(() => Promise.resolve(fake.engine), {
    now,
    afterPaint,
    startTimeoutMs: 5000,
    stallMs: 3000,
    retryDelaysMs: [1000, 2000],
    recoveredMs: 10_000,
  });
  return { fake, player };
};

const track = (id: string, kind: "audio" | "text", language?: string, selected = false): Track => ({
  id,
  kind,
  language,
  selected,
});
const chosen = (list: Track[]) => list.filter(one => one.selected).map(one => one.id);

describe("the player", () => {
  it("starts a stream and times its first picture", async () => {
    const fake = fakeEngine();
    const player = createPlayer(() => Promise.resolve(fake.engine), { now, afterPaint });
    await player.play({ url: "a" });
    expect(player.status()).toEqual({ state: "starting", stream: { url: "a" } });
    expect(videoWindow()).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });

    time = 1500;
    fake.opened[0]?.send({ type: "buffering" });
    expect(player.status().state).toBe("starting");
    fake.opened[0]?.send({ type: "playing" });
    expect(player.status()).toEqual({ state: "playing", stream: { url: "a" }, startMs: 1500 });

    fake.opened[0]?.send({ type: "buffering" });
    expect(player.status()).toMatchObject({ state: "buffering", startMs: 1500 });
    time = 9000;
    fake.opened[0]?.send({ type: "playing" });
    expect(player.status()).toMatchObject({ state: "playing", startMs: 1500 });
    fake.opened[0]?.send({ type: "ended" });
    expect(player.status().state).toBe("ended");

    player.stop();
    expect(player.status()).toEqual({ state: "idle" });
    expect(videoWindow()).toBeNull();
  });

  it("ignores a stream it has left", async () => {
    const fake = fakeEngine();
    const player = createPlayer(() => Promise.resolve(fake.engine), { now, afterPaint });
    // Both asked for before the engine has loaded: only the second opens.
    const first = player.play({ url: "a" });
    const second = player.play({ url: "b" });
    await Promise.all([first, second]);
    expect(fake.opened.map(o => o.stream.url)).toEqual(["b"]);

    await player.play({ url: "c" });
    fake.opened[0]?.send({ type: "error", error: "late" });
    fake.opened[0]?.send({ type: "playing" });
    expect(player.status()).toEqual({ state: "starting", stream: { url: "c" } });
  });

  it("switches once the UI has drawn, opening only the last stream asked for", async () => {
    const fake = fakeEngine();
    const paints: (() => void)[] = [];
    const player = createPlayer(() => Promise.resolve(fake.engine), {
      afterPaint: () => new Promise(resolve => paints.push(resolve)),
    });
    const asked = ["a", "b", "c"].map(url => player.play({ url }));
    // The status changes at once, before anything opens.
    expect(player.status()).toEqual({ state: "starting", stream: { url: "c" } });
    expect(fake.opened).toEqual([]);
    for (const paint of paints) paint();
    await Promise.all(asked);
    expect(fake.opened.map(o => o.stream.url)).toEqual(["c"]);
  });

  it("fails a stream that errors, can't open, or shows nothing in time", async () => {
    vi.useFakeTimers();
    const fake = fakeEngine();
    const player = createPlayer(() => Promise.resolve(fake.engine), {
      now,
      afterPaint,
      startTimeoutMs: 5000,
    });

    await player.play({ url: "a" });
    fake.opened[0]?.send({ type: "error", error: "PLAYER_ERROR_CONNECTION_FAILED" });
    expect(player.status()).toEqual({
      state: "failed",
      stream: { url: "a" },
      error: "PLAYER_ERROR_CONNECTION_FAILED",
    });

    await player.play({ url: "bad" });
    expect(player.status()).toMatchObject({ state: "failed", error: "bad URL" });

    // No engine can send a Referer; the stream before still stops.
    let stops = fake.stops();
    await player.play({ url: "r", referer: "http://site/" });
    expect(player.status()).toMatchObject({ state: "failed", error: NEEDS_REFERER });
    expect(fake.stops()).toBe(stops + 1);
    expect(fake.opened).toHaveLength(1);

    await player.play({ url: "b" });
    stops = fake.stops();
    vi.advanceTimersByTime(4999);
    expect(player.status().state).toBe("starting");
    vi.advanceTimersByTime(1);
    expect(player.status()).toMatchObject({ state: "failed", error: "timeout" });
    expect(fake.stops()).toBe(stops + 1);

    // A stream that started has no time limit.
    await player.play({ url: "c" });
    fake.opened[2]?.send({ type: "playing" });
    vi.advanceTimersByTime(60_000);
    expect(player.status().state).toBe("playing");
  });

  it("reports an engine that won't load, and tries again next time", async () => {
    const fake = fakeEngine();
    let attempts = 0;
    const player = createPlayer(
      () => (++attempts === 1 ? Promise.reject(new Error("no AVPlay")) : Promise.resolve(fake.engine)),
      { afterPaint },
    );
    await player.play({ url: "a" });
    expect(player.status()).toMatchObject({ state: "failed", error: "no AVPlay" });
    await player.play({ url: "a" });
    expect(fake.opened).toHaveLength(1);
  });

  it("moves the video window", async () => {
    const fake = fakeEngine();
    const player = createPlayer(() => Promise.resolve(fake.engine), { afterPaint });
    player.setWindow(PREVIEW);
    expect(videoWindow()).toBeNull();
    await player.play({ url: "a" });
    expect(videoWindow()).toEqual(PREVIEW);
    expect(fake.windows).toEqual([PREVIEW]);
    player.setWindow({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(fake.windows).toHaveLength(2);
    expect(videoWindow()?.width).toBe(1920);
    player.stop();
  });

  it("leaves the shared video window alone for a second player", async () => {
    const fake = fakeEngine();
    const shown: (typeof PREVIEW | null)[] = [];
    const player = createPlayer(() => Promise.resolve(fake.engine), {
      afterPaint,
      showVideo: rect => shown.push(rect),
    });
    player.setWindow(PREVIEW);
    await player.play({ url: "a" });
    expect(fake.windows).toEqual([PREVIEW]);
    expect(shown).toEqual([PREVIEW]);
    expect(videoWindow()).toBeNull();
    player.stop();
    expect(shown).toEqual([PREVIEW, null]);
  });

  describe("with a live stream", () => {
    it("reconnects after a growing delay, and gives up after the last try", async () => {
      const { fake, player } = liveSetup();
      await player.play(live);
      fake.last()?.send({ type: "playing" });
      fake.last()?.send({ type: "error", error: "PLAYER_ERROR_CONNECTION_FAILED" });
      expect(player.status()).toMatchObject({
        state: "reconnecting",
        error: "PLAYER_ERROR_CONNECTION_FAILED",
        attempt: 1,
        attempts: 2,
      });
      await wait(999);
      expect(fake.opened).toHaveLength(1);
      await wait(1);
      expect(fake.opened).toHaveLength(2);
      expect(player.status().state).toBe("reconnecting");

      // Nothing in time on the second try either; then a 2 s wait.
      await wait(5000);
      expect(player.status()).toMatchObject({ state: "reconnecting", error: "timeout", attempt: 2 });
      await wait(2000);
      expect(fake.opened).toHaveLength(3);
      fake.last()?.send({ type: "playing" });
      expect(player.status()).toMatchObject({ state: "playing", reconnects: 1 });

      // Out of tries before it has played long enough to start over.
      fake.last()?.send({ type: "ended" });
      expect(player.status()).toMatchObject({ state: "failed", error: DROPPED });
      await wait(60_000);
      expect(fake.opened).toHaveLength(3);
    });

    it("starts the tries over once it has played for a while", async () => {
      const { fake, player } = liveSetup();
      await player.play(live);
      fake.last()?.send({ type: "error", error: "network" });
      await wait(1000);
      fake.last()?.send({ type: "playing" });
      await wait(10_000);
      fake.last()?.send({ type: "error", error: "network" });
      expect(player.status()).toMatchObject({ state: "reconnecting", attempt: 1 });
    });

    it("notices a stream that stalls", async () => {
      const { fake, player } = liveSetup();
      await player.play(live);
      fake.last()?.send({ type: "playing" });
      // Buffering for too long.
      fake.last()?.send({ type: "buffering" });
      await wait(2000);
      expect(player.status().state).toBe("buffering");
      await wait(1000);
      expect(player.status()).toMatchObject({ state: "reconnecting", error: STALLED });

      // Playing, but no longer moving, once it had moved.
      await wait(1000);
      fake.last()?.send({ type: "playing" });
      fake.setPosition(500);
      await wait(1000);
      // Seen moving at the next check, then still for 3 s.
      fake.setPosition(1500);
      await wait(1000);
      await wait(2000);
      expect(player.status().state).toBe("playing");
      await wait(1000);
      expect(player.status()).toMatchObject({ state: "reconnecting", error: STALLED, attempt: 2 });
    });

    it("doesn't retry what reopening can't fix, or after stop()", async () => {
      const { fake, player } = liveSetup();
      await player.play({ ...live, referer: "http://site/" });
      expect(player.status()).toMatchObject({ state: "failed", error: NEEDS_REFERER });

      await player.play(live);
      fake.last()?.send({ type: "error", error: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT" });
      expect(player.status().state).toBe("failed");

      await player.play(live);
      fake.last()?.send({ type: "error", error: "network" });
      player.stop();
      await wait(10_000);
      expect(fake.opened).toHaveLength(2);
      expect(player.status().state).toBe("idle");
    });
  });

  describe("tracks", () => {
    it("lists a stream's tracks, and picks the languages chosen before on each stream", async () => {
      const fake = fakeEngine();
      let kept: TrackPreferences = {};
      const player = createPlayer(() => Promise.resolve(fake.engine), {
        now,
        afterPaint,
        preferences: { load: () => kept, save: preferences => void (kept = preferences) },
      });
      fake.setTracks([
        track("1", "audio", "eng", true),
        track("2", "audio", "deu"),
        track("3", "text", "en"),
        track("4", "text", "de"),
      ]);
      await player.play({ url: "a" });
      expect(player.tracks()).toEqual([]);
      // Nothing to choose until it plays.
      player.selectTrack("audio", "2");
      expect(fake.selected).toEqual([]);

      fake.last()?.send({ type: "playing" });
      expect(chosen(player.tracks())).toEqual(["1"]);
      expect(fake.selected).toEqual([]);

      player.selectTrack("audio", "2");
      player.selectTrack("text", "4");
      expect(chosen(player.tracks())).toEqual(["2", "4"]);
      expect(kept).toEqual({ audio: "deu", text: "de" });

      // The next stream names the languages differently.
      fake.setTracks([
        track("a", "audio", "en", true),
        track("b", "audio", "ger"),
        track("c", "text", "deu"),
        track("d", "audio"),
      ]);
      await player.play({ url: "b" });
      fake.last()?.send({ type: "playing" });
      expect(chosen(player.tracks())).toEqual(["b", "c"]);

      // Subtitles off is remembered too; a track with no language isn't.
      player.selectTrack("text", undefined);
      player.selectTrack("audio", "d");
      expect(chosen(player.tracks())).toEqual(["d"]);
      expect(kept).toEqual({ audio: "deu", text: undefined });
      await player.play({ url: "c" });
      fake.last()?.send({ type: "playing" });
      expect(chosen(player.tracks())).toEqual(["b"]);
      player.stop();
      expect(player.tracks()).toEqual([]);
    });

    it("picks the languages once the stream lists its tracks, if it lists them late", async () => {
      vi.useFakeTimers();
      const fake = fakeEngine();
      const player = createPlayer(() => Promise.resolve(fake.engine), {
        now,
        afterPaint,
        preferences: { load: () => ({ audio: "de" }), save: () => {} },
      });
      fake.setTracks([]);
      await player.play({ url: "a" });
      fake.last()?.send({ type: "playing" });
      expect(player.tracks()).toEqual([]);
      fake.addTracks([track("1", "audio", "en", true), track("2", "audio", "de")]);
      await wait(1000);
      expect(chosen(player.tracks())).toEqual(["2"]);
      // Only once: a choice made after stays.
      player.selectTrack("audio", "1");
      await wait(3000);
      expect(chosen(player.tracks())).toEqual(["1"]);
    });

    it("shows subtitle text for its duration", async () => {
      vi.useFakeTimers();
      const fake = fakeEngine();
      const player = createPlayer(() => Promise.resolve(fake.engine), { now, afterPaint });
      await player.play({ url: "a" });
      fake.last()?.send({ type: "playing" });
      fake.last()?.send({ type: "subtitle", text: "One", durationMs: 800 });
      expect(player.subtitle()).toBe("One");
      await wait(500);
      fake.last()?.send({ type: "subtitle", text: "Two", durationMs: 800 });
      await wait(500);
      expect(player.subtitle()).toBe("Two");
      await wait(300);
      expect(player.subtitle()).toBeUndefined();

      fake.last()?.send({ type: "subtitle", text: "Three", durationMs: 800 });
      fake.last()?.send({ type: "subtitle", text: "", durationMs: 0 });
      expect(player.subtitle()).toBeUndefined();
      fake.last()?.send({ type: "subtitle", text: "Four", durationMs: 800 });
      await player.play({ url: "b" });
      expect(player.subtitle()).toBeUndefined();
    });
  });

  describe("the app hidden, and the network", () => {
    it("closes the stream while hidden, and opens it again, timed afresh", async () => {
      const { fake, player } = liveSetup();
      player.suspend();
      expect(player.status()).toEqual({ state: "idle" });

      await player.play(live);
      fake.last()?.send({ type: "playing" });
      const stops = fake.stops();
      player.suspend();
      expect(player.status()).toEqual({ state: "suspended", stream: live });
      expect(fake.stops()).toBe(stops + 1);
      // What the closed stream says now changes nothing, and nothing reopens it.
      fake.last()?.send({ type: "error", error: "late" });
      await wait(60_000);
      expect(player.status().state).toBe("suspended");
      expect(fake.opened).toHaveLength(1);

      time = 100_000;
      player.resume();
      await wait(0);
      expect(fake.opened).toHaveLength(2);
      expect(player.status()).toEqual({ state: "starting", stream: live });
      await wait(700);
      fake.last()?.send({ type: "playing" });
      expect(player.status()).toEqual({ state: "playing", stream: live, startMs: 700 });
      // Only a suspended stream resumes.
      player.resume();
      expect(fake.opened).toHaveLength(2);
    });

    it("waits for the network instead of using up its tries", async () => {
      const { fake, player } = liveSetup();
      await player.play(live);
      fake.last()?.send({ type: "playing" });
      player.setOnline(false);
      fake.last()?.send({ type: "error", error: "PLAYER_ERROR_CONNECTION_FAILED" });
      expect(player.status()).toEqual({ state: "reconnecting", stream: live, error: OFFLINE, startMs: 0 });
      await wait(60_000);
      expect(fake.opened).toHaveLength(1);

      player.setOnline(true);
      await wait(0);
      expect(fake.opened).toHaveLength(2);
      fake.last()?.send({ type: "playing" });
      expect(player.status()).toMatchObject({ state: "playing", reconnects: 1 });

      // A try already waiting when the network goes finds it gone, and waits too.
      fake.last()?.send({ type: "error", error: "PLAYER_ERROR_CONNECTION_FAILED" });
      expect(player.status()).toMatchObject({ state: "reconnecting", attempt: 1 });
      player.setOnline(false);
      await wait(1000);
      fake.last()?.send({ type: "error", error: "PLAYER_ERROR_CONNECTION_FAILED" });
      expect(player.status()).toMatchObject({ state: "reconnecting", error: OFFLINE });
      // Stopping forgets it.
      player.stop();
      player.setOnline(true);
      await wait(0);
      expect(fake.opened).toHaveLength(3);
    });
  });

  describe("films and recordings", () => {
    const film = { url: "film" };

    it("pauses, plays on and seeks, without taking a pause for a stall", async () => {
      const { fake, player } = liveSetup();
      void player.play({ ...film, startMs: 60_000 });
      await wait(0);
      expect(fake.last()?.stream.startMs).toBe(60_000);
      fake.last()?.send({ type: "playing" });
      fake.setPosition(61_000);
      await wait(1000);
      player.setPaused(true);
      expect(player.status().state).toBe("paused");
      // AVPlay may report buffering while paused.
      fake.last()?.send({ type: "buffering" });
      await wait(10_000);
      expect(player.status().state).toBe("paused");
      player.setPaused(false);
      expect(player.status().state).toBe("playing");
      player.seek(120_000);
      expect(fake.calls).toEqual(["pause", "play", "seek 120000"]);
      expect(player.duration()).toBe(360_000);
    });

    it("doesn't seek a live stream", async () => {
      const { fake, player } = liveSetup();
      void player.play(live);
      await wait(0);
      fake.last()?.send({ type: "playing" });
      player.seek(5000);
      expect(fake.calls).toEqual([]);
    });

    it("opens a film that dropped again where it was, a few times", async () => {
      const { fake, player } = liveSetup();
      void player.play(film);
      await wait(0);
      fake.last()?.send({ type: "playing" });
      fake.setPosition(90_000);
      await wait(1000);
      fake.last()?.send({ type: "error", error: "PLAYER_ERROR_CONNECTION_FAILED" });
      expect(player.status()).toMatchObject({ state: "reconnecting", attempt: 1, attempts: 2 });
      await wait(1000);
      expect(fake.last()?.stream).toEqual({ url: "film", startMs: 90_000 });
      fake.last()?.send({ type: "error", error: "PLAYER_ERROR_CONNECTION_FAILED" });
      await wait(2000);
      fake.last()?.send({ type: "error", error: "PLAYER_ERROR_CONNECTION_FAILED" });
      expect(player.status().state).toBe("failed");
    });

    it("fails a film that never starts, at once", async () => {
      const { fake, player } = liveSetup();
      void player.play(film);
      await wait(0);
      fake.last()?.send({ type: "error", error: "PLAYER_ERROR_CONNECTION_FAILED" });
      expect(player.status().state).toBe("failed");
    });

    it("keeps a film's place while the app is hidden", async () => {
      const { fake, player } = liveSetup();
      void player.play(film);
      await wait(0);
      fake.last()?.send({ type: "playing" });
      fake.setPosition(42_000);
      player.suspend();
      expect(player.status()).toEqual({ state: "suspended", stream: { url: "film", startMs: 42_000 } });
      player.resume();
      await wait(0);
      expect(fake.last()?.stream.startMs).toBe(42_000);
    });
  });

  it("doesn't wait for a frame that never comes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 0);
    try {
      let painted = false;
      void nextPaint().then(() => (painted = true));
      await vi.advanceTimersByTimeAsync(PAINT_WAIT_MS - 1);
      expect(painted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(painted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
