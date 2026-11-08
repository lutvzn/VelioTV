import { EDeviceType } from "#devices/devices";
import { DeviceCommon } from "#devices/common/device";
import { AvplayEngine } from "./player";

declare const tizen: any;
declare const webapis: any;

// Tizen only sends these remote keys to apps that register them. Arrows,
// Enter and Back always arrive.
const REMOTE_KEYS = [
  "MediaPlay",
  "MediaPause",
  "MediaPlayPause",
  "MediaStop",
  "MediaFastForward",
  "MediaRewind",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "ChannelUp",
  "ChannelDown",
  "Info",
  "ChannelList",
  "Guide",
  "Tools",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
];

export class TizenDevice extends DeviceCommon {
  static addScript(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "$WEBAPIS/webapis/webapis.js";
      script.addEventListener("load", () => resolve(true), { once: true });
      script.addEventListener(
        "error",
        () => reject(new Error("Failed load device Script $WEBAPIS/webapis/webapis.js")),
        { once: true },
      );
      document.body.appendChild(script);
    });
  }

  static registerRemoteKeys() {
    // A key this TV lacks would make the whole batch fail, so only ask for
    // supported ones.
    const supported = new Set(tizen.tvinputdevice.getSupportedKeys().map(key => key.name));
    tizen.tvinputdevice.registerKeyBatch(REMOTE_KEYS.filter(key => supported.has(key)));
  }

  static async initialize() {
    TizenDevice.registerRemoteKeys();
    // Samsung's product APIs, such as AVPlay. Without them the app still
    // runs, with the <video> engine.
    await TizenDevice.addScript().catch(error => console.warn(error));
    return new TizenDevice(EDeviceType.TIZEN);
  }

  async closeApp() {
    tizen.application.getCurrentApplication().exit();
  }

  // Samsung's voice guide (PLAN.md, Phase 8, step 5): tvinfo says whether
  // it's on, and calls back when it changes; it is read again when the app
  // comes back to the front, in case the call doesn't come.
  watchVoiceGuide(changed: (on: boolean) => void) {
    const tvinfo = typeof webapis === "undefined" ? undefined : webapis.tvinfo;
    if (!tvinfo) return;
    const key = tvinfo.TvInfoMenuKey.VOICE_GUIDE_KEY;
    const read = () => {
      try {
        changed(tvinfo.getMenuValue(key) === tvinfo.TvInfoMenuValue.ON);
      } catch (error) {
        console.warn("Couldn't read the voice guide setting:", error);
      }
    };
    read();
    try {
      tvinfo.addCaptionChangeListener(key, read);
    } catch (error) {
      console.warn("No calls when the voice guide changes:", error);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") read();
    });
  }

  protected _getPlayer() {
    return typeof webapis === "undefined" ? super._getPlayer() : new AvplayEngine(webapis.avplay);
  }

  // Samsung's avplaystore (Tizen 6+) gives further players; the sub video
  // scaler plays a second stream (PLAN.md, Phase 0, test 5, and Phase 7).
  hasSecondPlayer() {
    return typeof webapis !== "undefined" && Boolean(webapis.avplaystore);
  }

  protected _getSecondPlayer() {
    if (typeof webapis === "undefined" || !webapis.avplaystore) return undefined;
    try {
      return new AvplayEngine(webapis.avplaystore.getPlayer(), { second: true });
    } catch (error) {
      console.warn("No second player:", error);
      return undefined;
    }
  }
}
