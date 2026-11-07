import { describe, expect, it } from "vitest";
import type { EngineEvent } from "#devices/common/player";
import { type Avplay, AvplayEngine, type AvplayListener } from "./player";

// A track as the TV lists it: audio has "language", subtitles "track_lang".
const info = (index: number, type: string, extra: object) => ({
  index,
  type,
  extra_info: JSON.stringify(extra),
});

// Enough of AVPlay to follow its states and record what the engine asks of it.
const fakeAvplay = () => {
  const calls: string[] = [];
  const prepares: { success: () => void; error: (error: unknown) => void }[] = [];
  let state = "NONE";
  let listener: AvplayListener = {};
  // Out of order, as AVPlay lists raw TS's tracks.
  const all = [
    info(0, "VIDEO", { fourCC: "H264", Width: 1920, Height: 1080 }),
    info(2, "AUDIO", { language: "deu", fourCC: "AAC", channels: 2 }),
    info(1, "AUDIO", { language: "eng", fourCC: "AAC", channels: 2 }),
    info(3, "TEXT", { track_lang: "en", fourCC: "text/plain" }),
    info(4, "TEXT", { track_lang: "de", fourCC: "text/plain" }),
  ];
  const current = new Map([
    ["VIDEO", 0],
    ["AUDIO", 1],
    ["TEXT", 3],
  ]);
  const av: Avplay = {
    open: url => {
      if (state !== "NONE") throw new Error("InvalidStateError");
      calls.push(`open ${url}`);
      state = "IDLE";
    },
    close: () => {
      calls.push("close");
      state = "NONE";
    },
    stop: () => {
      if (state === "NONE") throw new Error("InvalidStateError");
      calls.push("stop");
      state = "IDLE";
    },
    play: () => {
      calls.push("play");
      state = "PLAYING";
    },
    prepareAsync: (success, error) => prepares.push({ success, error }),
    setListener: value => (listener = value),
    setDisplayRect: (x, y, width, height) => calls.push(`rect ${x},${y},${width},${height}`),
    setDisplayMethod: method => calls.push(method),
    setBufferingParam: (when, _unit, amount) => calls.push(`buffer ${when} ${amount}`),
    setStreamingProperty: (name, value) => calls.push(`${name}=${value}`),
    getState: () => state,
    getCurrentTime: () => 1234,
    getCurrentStreamInfo: () => all.filter(track => current.get(track.type) === track.index),
    getTotalTrackInfo: () => all,
    setSelectTrack: (type, index) => {
      calls.push(`select ${type} ${index}`);
      current.set(type, index);
    },
    setSilentSubtitle: silent => calls.push(`silent ${silent}`),
  };
  const prepared = (at: number) => {
    state = "READY";
    prepares[at]?.success();
  };
  return {
    av,
    calls,
    prepares,
    prepared,
    listener: () => listener,
  };
};

describe("the AVPlay engine", () => {
  it("opens a stream with its settings, and reports its first picture", () => {
    const fake = fakeAvplay();
    const engine = new AvplayEngine(fake.av, { bufferSeconds: 3 });
    const events: EngineEvent[] = [];
    engine.setWindow({ x: 10, y: 20, width: 960, height: 540 });
    engine.open({ url: "http://a/1.ts", userAgent: "Box" }, event => events.push(event));
    expect(fake.calls).toEqual([
      "open http://a/1.ts",
      "USER_AGENT=Box",
      "PLAYER_DISPLAY_MODE_LETTER_BOX",
      "rect 10,20,960,540",
      "buffer PLAYER_BUFFER_FOR_PLAY 3",
      "buffer PLAYER_BUFFER_FOR_RESUME 3",
      "silent true",
    ]);
    expect(document.querySelector('object[type="application/avplayer"]')).not.toBeNull();

    fake.prepared(0);
    expect(fake.calls[fake.calls.length - 1]).toBe("play");
    fake.listener().onbufferingcomplete?.();
    fake.listener().onbufferingstart?.();
    fake.listener().onerror?.("PLAYER_ERROR_CONNECTION_FAILED");
    expect(events).toEqual([
      { type: "buffering" },
      { type: "playing" },
      { type: "buffering" },
      { type: "error", error: "PLAYER_ERROR_CONNECTION_FAILED" },
    ]);
    expect(engine.position()).toBe(1234);
    expect(engine.formats()).toEqual(["VIDEO H264 1920x1080", "AUDIO AAC 2ch", "TEXT text/plain"]);
  });

  it("drops a stream that is still opening when another is asked for", () => {
    const fake = fakeAvplay();
    const engine = new AvplayEngine(fake.av);
    const first: EngineEvent[] = [];
    const second: EngineEvent[] = [];
    engine.open({ url: "http://a/1.ts" }, event => first.push(event));
    engine.open({ url: "http://a/2.ts" }, event => second.push(event));
    expect(fake.calls.filter(call => /open|stop|close/.test(call))).toEqual([
      "open http://a/1.ts",
      "close",
      "open http://a/2.ts",
    ]);

    // The first stream's late answers change nothing.
    fake.prepared(0);
    fake.prepares[0]?.error(new Error("cancelled"));
    expect(fake.calls).not.toContain("play");
    expect(first).toEqual([{ type: "buffering" }]);

    fake.prepared(1);
    fake.listener().onbufferingcomplete?.();
    expect(second).toEqual([{ type: "buffering" }, { type: "playing" }]);
  });

  it("stops quietly, whatever state AVPlay is in", () => {
    const fake = fakeAvplay();
    const engine = new AvplayEngine(fake.av);
    engine.stop();
    engine.open({ url: "http://a/1.ts" }, () => {});
    engine.stop();
    engine.stop();
    expect(fake.calls.filter(call => /stop|close/.test(call))).toEqual(["close"]);
    // Only applied to an open stream.
    engine.setWindow({ x: 0, y: 0, width: 100, height: 100 });
    expect(fake.calls[fake.calls.length - 1]).toBe("close");
  });

  it("lists and picks tracks, and passes on subtitles only while shown", () => {
    const fake = fakeAvplay();
    const engine = new AvplayEngine(fake.av);
    const events: EngineEvent[] = [];
    engine.open({ url: "http://a/tracks.m3u8" }, event => events.push(event));
    fake.prepared(0);
    expect(engine.tracks()).toEqual([
      { id: "1", kind: "audio", language: "eng", selected: true },
      { id: "2", kind: "audio", language: "deu", selected: false },
      // AVPlay has a subtitle track on, but hidden.
      { id: "3", kind: "text", language: "en", selected: false },
      { id: "4", kind: "text", language: "de", selected: false },
    ]);
    fake.listener().onsubtitlechange?.("800", "Hidden\u0000");

    engine.selectTrack("audio", "2");
    engine.selectTrack("text", "4");
    expect(fake.calls.slice(-3)).toEqual(["select AUDIO 2", "silent false", "select TEXT 4"]);
    expect(
      engine
        .tracks()
        .filter(track => track.selected)
        .map(track => track.id),
    ).toEqual(["2", "4"]);
    fake.listener().onsubtitlechange?.("800", "<i>Deutscher Untertitel</i>\u0000");

    engine.selectTrack("text", undefined);
    expect(fake.calls[fake.calls.length - 1]).toBe("silent true");
    expect(
      engine
        .tracks()
        .filter(track => track.selected)
        .map(track => track.id),
    ).toEqual(["2"]);
    fake.listener().onsubtitlechange?.("800", "Hidden again");
    expect(events.filter(event => event.type === "subtitle")).toEqual([
      { type: "subtitle", text: "Deutscher Untertitel", durationMs: 800 },
    ]);
  });
});
