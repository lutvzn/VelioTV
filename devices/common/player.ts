import shaka from "shaka-player";

export interface Player {
  isPaused(): boolean;
  getDuration(): number;
  getCurrentPosition(): number;
  play(): Promise<void>;
  pause(): void;
  stop(): Promise<void>;
  /** Jumps to a position, in seconds from the start. */
  seek(position: number): void;
  /** Moves by a number of seconds. A negative number goes back. */
  skip(seconds: number): void;
}

export class CommonPlayer implements Player {
  private readonly _player: shaka.Player;
  private readonly _videoElement: HTMLVideoElement;

  constructor(videoElement?: HTMLVideoElement) {
    this._videoElement = videoElement || this.createVideoElement();
    this._player = new shaka.Player(this._videoElement);
    this._player.addEventListener("error", event => console.error("Shaka Player error:", event));
  }

  private createVideoElement(): HTMLVideoElement {
    const video = document.createElement("video");
    video.style.position = "absolute";
    video.style.top = "0";
    video.style.left = "0";
    video.style.width = "100%";
    video.style.height = "100%";
    // Behind the app's canvas, which shows the video through transparent
    // areas such as the holePunch shader.
    video.style.zIndex = "-1";
    document.body.appendChild(video);
    return video;
  }

  async load(streamUrl: string, autoPlay = false, startTime?: number): Promise<void> {
    try {
      await this._player.load(streamUrl, startTime);
      if (autoPlay) await this._videoElement.play();
      console.log("Stream loaded successfully");
    } catch (error) {
      console.error("Failed to load stream:", error);
      throw error;
    }
  }

  isPaused(): boolean {
    return this._videoElement.paused;
  }

  getDuration(): number {
    return this._videoElement.duration;
  }

  getCurrentPosition(): number {
    return this._videoElement.currentTime;
  }

  async togglePlayPause(): Promise<void> {
    if (this._videoElement.paused) await this.play();
    else this.pause();
  }

  play(): Promise<void> {
    return this._videoElement.play();
  }

  // Keeps the same Shaka player, ready for the next load().
  async stop(): Promise<void> {
    await this._player.unload();
  }

  pause(): void {
    this._videoElement.pause();
  }

  seek(position: number): void {
    this._videoElement.currentTime = position;
  }

  skip(seconds: number): void {
    this._videoElement.currentTime += seconds;
  }
}
