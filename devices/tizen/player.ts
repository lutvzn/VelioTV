// Samsung's AVPlay, which plays raw MPEG-TS and HLS natively (PLAN.md,
// Phase 0). It draws video on a layer behind the web page, at the rectangle
// given by setDisplayRect(); the app cuts a hole in its background there.

import {
  errorText,
  type DisplayRect,
  type EngineEvent,
  type PlaybackEngine,
  type Stream,
  type Track,
  type TrackKind,
} from "#devices/common/player";

/** The AVPlay events the engine listens for. */
export interface AvplayListener {
  onbufferingstart?(): void;
  onbufferingcomplete?(): void;
  onstreamcompleted?(): void;
  onerror?(error: unknown): void;
  /** Subtitle text to show for `duration` ms (a string, on the TV), ending in a NUL. */
  onsubtitlechange?(duration: unknown, text: unknown): void;
}

/** A track, as getTotalTrackInfo() and getCurrentStreamInfo() give it. */
export interface AvplayTrack {
  index: number;
  type: string;
  /** JSON: "language" for audio, "track_lang" for subtitles. */
  extra_info?: string;
}

/** The parts of `webapis.avplay` the engine uses. */
export interface Avplay {
  open(url: string): void;
  close(): void;
  stop(): void;
  play(): void;
  prepareAsync(onSuccess: () => void, onError: (error: unknown) => void): void;
  setListener(listener: AvplayListener): void;
  setDisplayRect(x: number, y: number, width: number, height: number): void;
  setDisplayMethod(method: string): void;
  setBufferingParam(when: string, unit: string, amount: number): void;
  setStreamingProperty(name: string, value: string): void;
  pause(): void;
  seekTo(ms: number, onSuccess?: () => void, onError?: (error: unknown) => void): void;
  getState(): string;
  getCurrentTime(): number;
  getDuration(): number;
  getCurrentStreamInfo(): AvplayTrack[];
  getTotalTrackInfo(): AvplayTrack[];
  setSelectTrack(type: string, index: number): void;
  setSilentSubtitle(silent: boolean): void;
  /** Plays without sound, for a second player. */
  disableAudioStream?(): void;
}

const extraInfo = (info: AvplayTrack) => {
  try {
    const extra: unknown = JSON.parse(info.extra_info || "{}");
    return (name: string) => {
      const value: unknown = typeof extra === "object" && extra ? Reflect.get(extra, name) : undefined;
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    };
  } catch {
    return () => "";
  }
};

const KINDS: Record<string, TrackKind | undefined> = { AUDIO: "audio", TEXT: "text" };
const AVPLAY_TYPES: Record<TrackKind, string> = { audio: "AUDIO", text: "TEXT" };

export interface AvplayOptions {
  /**
   * How much to buffer before starting, and after a stall. AVPlay's default
   * took about 10 s to start raw TS on the TV; 1-3 s took about 3.4 s.
   */
  bufferSeconds?: number;
  /**
   * A second player, beside the main one (PLAN.md, Phase 7): it plays on the
   * TV's sub video scaler, without sound. Samsung's avplaystore gives the
   * player; with the main one from webapis.avplay, both play at once.
   */
  second?: boolean;
}

const FULL_SCREEN: DisplayRect = { x: 0, y: 0, width: 1920, height: 1080 };

export class AvplayEngine implements PlaybackEngine {
  readonly name = "avplay";
  private element?: HTMLObjectElement;
  private rect = FULL_SCREEN;
  private session = 0;
  /** Whether the stream playing shows its subtitles. */
  private subtitles = false;

  constructor(
    private readonly av: Avplay,
    private readonly options: AvplayOptions = {},
  ) {}

  open(stream: Stream, onEvent: (event: EngineEvent) => void) {
    this.stop();
    const session = this.session;
    const send = (event: EngineEvent) => {
      if (session === this.session) onEvent(event);
    };
    this.attach();

    const { av } = this;
    av.open(stream.url);
    if (stream.userAgent) av.setStreamingProperty("USER_AGENT", stream.userAgent);
    if (this.options.second) {
      av.disableAudioStream?.();
      av.setStreamingProperty("IN_APP_MULTIVIEW", "VIDEO_VIEW_RESOURCE_SUB");
    }
    try {
      av.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX");
    } catch {
      // Older TVs may not have it; video then fills the window.
    }
    this.applyRect();
    // A file on the TV, such as a recording: AVPlay doesn't buffer it, and
    // stays at its start if told how much to buffer (PLAN.md, Phase 7, step 4).
    const local = stream.url.startsWith("file:");
    const seconds = this.options.bufferSeconds ?? 2;
    for (const when of local ? [] : ["PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_FOR_RESUME"]) {
      av.setBufferingParam(when, "PLAYER_BUFFER_SIZE_IN_SECOND", seconds);
    }
    av.setListener({
      onbufferingstart: () => send({ type: "buffering" }),
      // AVPlay calls a stream prepared before it can show anything, so this
      // is the first picture (PLAN.md, Phase 0).
      onbufferingcomplete: () => send({ type: "playing" }),
      onstreamcompleted: () => send({ type: "ended" }),
      onerror: (error: unknown) => send({ type: "error", error: errorText(error) }),
      // AVPlay leaves the drawing to the app.
      onsubtitlechange: (duration: unknown, text: unknown) =>
        this.subtitles &&
        send({
          type: "subtitle",
          text: (typeof text === "string" ? text : "")
            .split("\u0000")
            .join("")
            .replace(/<[^>]*>/g, "")
            .trim(),
          durationMs: Number(duration) || 0,
        }),
    });
    // Subtitles start hidden, until one is chosen.
    this.subtitles = false;
    try {
      av.setSilentSubtitle(true);
    } catch {
      // Not every stream has subtitles to hide.
    }
    send({ type: "buffering" });
    const play = () => {
      if (session !== this.session) return;
      try {
        av.play();
        // No buffering events come for a file.
        if (local) send({ type: "playing" });
      } catch (error) {
        send({ type: "error", error: errorText(error) });
      }
    };
    av.prepareAsync(
      () => {
        if (session !== this.session) return;
        // A film carried on from before: AVPlay can seek once prepared,
        // before it plays (PLAN.md, Phase 6, step 1).
        if (!stream.startMs) return play();
        try {
          av.seekTo(stream.startMs, play, play);
        } catch {
          play();
        }
      },
      error => send({ type: "error", error: errorText(error) }),
    );
  }

  // close() alone, without stop() first: on the TV, stop() and close() took
  // 140-750 ms together while close() took 150-270 ms, and both block the UI.
  stop() {
    this.session++;
    if (this.av.getState() === "NONE") return;
    try {
      this.av.close();
    } catch {
      // Already closed.
    }
  }

  setWindow(rect: DisplayRect) {
    this.rect = rect;
    if (this.av.getState() !== "NONE") this.applyRect();
  }

  position() {
    try {
      return this.av.getCurrentTime();
    } catch {
      return 0;
    }
  }

  duration() {
    try {
      const ms = this.av.getDuration();
      return Number.isFinite(ms) && ms > 0 ? ms : 0;
    } catch {
      return 0;
    }
  }

  setPaused(paused: boolean) {
    const state = this.av.getState();
    try {
      if (paused && state === "PLAYING") this.av.pause();
      else if (!paused && state === "PAUSED") this.av.play();
    } catch {
      // Not in a state that pauses, such as while it opens.
    }
  }

  seek(ms: number) {
    const state = this.av.getState();
    if (state !== "PLAYING" && state !== "PAUSED" && state !== "READY") return;
    try {
      this.av.seekTo(Math.max(0, Math.round(ms)));
    } catch {
      // Live streams and some recordings can't seek.
    }
  }

  formats() {
    try {
      return this.av.getCurrentStreamInfo().map(info => {
        const field = extraInfo(info);
        const parts = [info.type, field("fourCC") || "?"];
        if (field("Width")) parts.push(`${field("Width")}x${field("Height")}`);
        if (field("channels")) parts.push(`${field("channels")}ch`);
        return parts.join(" ");
      });
    } catch {
      return [];
    }
  }

  tracks(): Track[] {
    let all: AvplayTrack[];
    let current: AvplayTrack[];
    try {
      all = this.av.getTotalTrackInfo();
      current = this.av.getCurrentStreamInfo();
    } catch {
      return [];
    }
    const playing = new Set(current.map(info => `${info.type} ${info.index}`));
    const tracks: Track[] = [];
    for (const info of all) {
      const kind = KINDS[info.type];
      if (!kind) continue;
      const field = extraInfo(info);
      const on = playing.has(`${info.type} ${info.index}`);
      tracks.push({
        id: String(info.index),
        kind,
        language: (kind === "audio" ? field("language") : field("track_lang")) || undefined,
        selected: kind === "audio" ? on : on && this.subtitles,
      });
    }
    // AVPlay lists raw TS's tracks out of order. (Not toSorted(): older TVs lack it.)
    tracks.sort((a, b) => Number(a.id) - Number(b.id));
    return tracks;
  }

  // On the TV, changing audio blocks for about 110 ms (PLAN.md, Phase 3).
  selectTrack(kind: TrackKind, id: string | undefined) {
    const { av } = this;
    if (kind === "text") {
      this.subtitles = id !== undefined;
      av.setSilentSubtitle(!this.subtitles);
    }
    if (id !== undefined) av.setSelectTrack(AVPLAY_TYPES[kind], Number(id));
  }

  // AVPlay needs this element in the page, though it draws elsewhere. It is
  // kept out of the layout, or the arrow keys could scroll the page.
  private attach() {
    if (this.element) return;
    this.element = document.createElement("object");
    this.element.type = "application/avplayer";
    this.element.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px";
    document.body.appendChild(this.element);
  }

  private applyRect() {
    const { x, y, width, height } = this.rect;
    this.av.setDisplayRect(x, y, width, height);
  }
}
