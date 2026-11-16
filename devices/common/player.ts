// One playback backend per TV, behind one interface (PLAN.md, Key decisions):
// AVPlay on Samsung (devices/tizen/player.ts) and, for now, a <video> element
// everywhere else, for the desktop browser. The app plays through
// src/player/player.ts, which sits on top of whichever engine the TV has.

/** Where video shows, in pixels of the 1920x1080 app. */
export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Stream {
  url: string;
  /** Sent as the User-Agent, on engines that can. */
  userAgent?: string;
  /**
   * The Referer the server wants. No engine can send one (PLAN.md, Phase 0),
   * so the app's player refuses such streams.
   */
  referer?: string;
  /**
   * A live channel, which never ends: the app's player reconnects when it
   * drops, stalls or fails to start, rather than stopping.
   */
  live?: boolean;
  /** Where to start, in milliseconds, for a film or recording carried on from before. */
  startMs?: number;
  /**
   * How long the app's player waits for the first picture, when not its
   * usual time: a debrid add-on's link can take a while to resolve.
   */
  startTimeoutMs?: number;
  /** Who is giving the stream, such as an add-on, named while it starts. */
  from?: string;
  /**
   * A link that redirects to the file, as a debrid add-on's does: the app's
   * player follows it first, and gives the engine where it ends.
   */
  redirects?: boolean;
  /**
   * Gives the link to play, when it must first be asked for, as a debrid
   * service's for a torrent (src/debrid/). The app's player asks for it
   * first; its error is the stream's.
   */
  resolve?: () => Promise<string>;
}

/** An audio or subtitle track of the stream playing. */
export interface Track {
  /** The engine's own name for it, to give back to selectTrack(). */
  id: string;
  kind: TrackKind;
  /** As the stream gives it, such as "en" or "deu". */
  language?: string;
  /** A name the stream gives it, if any. */
  label?: string;
  /** Playing, or for subtitles, showing. */
  selected: boolean;
}

export type TrackKind = "audio" | "text";

export type EngineEvent =
  /** Waiting for data: before the first picture, or after a stall. */
  | { type: "buffering" }
  /** Showing pictures. */
  | { type: "playing" }
  /** The stream finished, or the server closed it. */
  | { type: "ended" }
  | { type: "error"; error: string }
  /**
   * Subtitle text to show now, for `durationMs`, from engines that leave the
   * drawing to the app. Empty text clears it.
   */
  | { type: "subtitle"; text: string; durationMs: number };

export interface PlaybackEngine {
  readonly name: string;
  /**
   * Stops whatever is playing and starts `stream`. Events go to `onEvent`
   * until the next open() or stop(). It may throw if the stream can't be
   * opened at all.
   */
  open(stream: Stream, onEvent: (event: EngineEvent) => void): void;
  stop(): void;
  setWindow(rect: DisplayRect): void;
  /** How far the stream has played, in milliseconds. */
  position(): number;
  /** How long the stream is, in milliseconds; 0 for live streams, or before it is known. */
  duration(): number;
  /** Pauses the stream, or plays it on from where it was paused. */
  setPaused(paused: boolean): void;
  /** Jumps to `ms` from the start, for streams that have a length. */
  seek(ms: number): void;
  /** The stream's formats, such as "VIDEO H264 1920x1080", to show when diagnosing. */
  formats(): string[];
  /** The stream's audio and subtitle tracks, once it has started. */
  tracks(): Track[];
  /** Plays an audio track, or shows a subtitle track; `undefined` hides subtitles. */
  selectTrack(kind: TrackKind, id: string | undefined): void;
}

/** An error's message. TV APIs throw objects that aren't Errors but have a name and message. */
export const errorText = (error: unknown) => {
  if (typeof error === "object" && error !== null) {
    const { message, name } = error as { message?: unknown; name?: unknown };
    if (typeof message === "string" && message) return message;
    if (typeof name === "string" && name) return name;
  }
  return typeof error === "string" || typeof error === "number" ? String(error) : "unknown error";
};

import type shaka from "shaka-player";

const shakaTrack = (kind: TrackKind, track: shaka.extern.AudioTrack | shaka.extern.TextTrack): Track => ({
  id: kind === "audio" ? `${track.language}|${track.label ?? ""}` : String(track.id),
  kind,
  language: track.language || undefined,
  label: track.label || undefined,
  selected: track.active,
});

const percent = (value: number, of: number) => `${(value / of) * 100}%`;

/**
 * A <video> element behind the app's canvas, which shows it through the
 * background's hole. Shaka Player plays HLS and DASH; raw MPEG-TS needs
 * AVPlay. Shaka is loaded on first use, so TV builds that never use this
 * engine don't load it.
 */
export class VideoElementEngine implements PlaybackEngine {
  readonly name = "video";
  private readonly video: HTMLVideoElement;
  private shaka?: Promise<shaka.Player>;
  /** Shaka, once a stream has loaded. */
  private loaded?: shaka.Player;
  private session = 0;
  /** The current stream's listener. */
  private send?: (event: EngineEvent) => void;

  constructor() {
    this.video = document.createElement("video");
    // Behind the canvas; setWindow() places it.
    this.video.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;z-index:-1";
    this.video.addEventListener("waiting", () => this.send?.({ type: "buffering" }));
    this.video.addEventListener("playing", () => this.send?.({ type: "playing" }));
    this.video.addEventListener("ended", () => this.send?.({ type: "ended" }));
  }

  private player() {
    this.shaka ??= import("shaka-player").then(({ default: library }) => {
      document.body.appendChild(this.video);
      return new library.Player(this.video);
    });
    return this.shaka;
  }

  open(stream: Stream, onEvent: (event: EngineEvent) => void) {
    const session = ++this.session;
    const send = (event: EngineEvent) => {
      if (session === this.session) onEvent(event);
    };
    this.send = send;
    this.loaded = undefined;
    send({ type: "buffering" });
    void (async () => {
      try {
        const player = await this.player();
        if (session !== this.session) return;
        await player.load(stream.url, stream.startMs ? stream.startMs / 1000 : undefined);
        if (session !== this.session) return;
        this.loaded = player;
        await this.video.play();
      } catch (error) {
        send({ type: "error", error: errorText(error) });
      }
    })();
  }

  stop() {
    this.session++;
    this.send = undefined;
    this.loaded = undefined;
    void this.shaka?.then(player => player.unload()).catch(() => {});
  }

  setWindow(rect: DisplayRect) {
    Object.assign(this.video.style, {
      left: percent(rect.x, 1920),
      top: percent(rect.y, 1080),
      width: percent(rect.width, 1920),
      height: percent(rect.height, 1080),
    });
  }

  position() {
    return Math.round(this.video.currentTime * 1000);
  }

  duration() {
    const seconds = this.video.duration;
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
  }

  setPaused(paused: boolean) {
    if (paused) this.video.pause();
    else void this.video.play().catch(() => {});
  }

  seek(ms: number) {
    this.video.currentTime = ms / 1000;
  }

  formats() {
    const { videoWidth, videoHeight } = this.video;
    return videoWidth ? [`VIDEO ${videoWidth}x${videoHeight}`] : [];
  }

  tracks() {
    const player = this.loaded;
    if (!player) return [];
    return [
      ...player.getAudioTracks().map(track => shakaTrack("audio", track)),
      ...player.getTextTracks().map(track => shakaTrack("text", track)),
    ];
  }

  // Shaka draws the subtitles itself, over the video.
  selectTrack(kind: TrackKind, id: string | undefined) {
    const player = this.loaded;
    if (!player) return;
    if (kind === "audio") {
      const track = player.getAudioTracks().find(one => shakaTrack("audio", one).id === id);
      if (track) player.selectAudioTrack(track);
      return;
    }
    player.selectTextTrack(player.getTextTracks().find(one => String(one.id) === id) ?? null);
  }
}
