import { EDeviceType } from "#devices/devices";
import { DeviceCommon } from "#devices/common/device";
import { TizenPlayer } from "./player";

declare const tizen: any;

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
    // Samsung's product APIs, such as AVPlay. Nothing uses them yet, so a
    // failure here shouldn't stop the app.
    await TizenDevice.addScript().catch(error => console.warn(error));
    return new TizenDevice(EDeviceType.TIZEN);
  }

  async closeApp() {
    tizen.application.getCurrentApplication().exit();
  }

  protected _getPlayer() {
    return new TizenPlayer();
  }
}
