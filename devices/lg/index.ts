import { DeviceConfig } from "#devices/devices";
import { config as common } from "#devices/common";
import { LgDevice } from "./device";
import { merge } from "lodash-es";

export const config: DeviceConfig = merge({}, common, {
  name: "lg",
  quality: {
    image: {
      ratio: 0.1,
      quality: 1,
    },
  },
  lightning: {
    rendererOptions: {
      // As on Tizen; the renderer goes without them where the browser
      // lacks what they need (createImageBitmap, Chromium 50).
      numImageWorkers: 2,
    },
  },
  keys: {
    Back: 461,
    Left: 37,
    Right: 39,
    Up: 38,
    Down: 40,
    Enter: 13,
    Play: 415,
    Pause: 19,
    PlayPause: -1,
    FastForward: 417,
    FastForward10: -1,
    Rewind: 412,
    Rewind10: -1,
    Stop: 413,
    // LG remotes send channel up and down as Page Up and Page Down.
    ChannelUp: 33,
    ChannelDown: 34,
    Info: 457,
    // webOS sends every remote key without registering; to be checked on
    // the TV which of Guide, ChannelList and Tools LG remotes have.
    Key0: 48,
    Key1: 49,
    Key2: 50,
    Key3: 51,
    Key4: 52,
    Key5: 53,
    Key6: 54,
    Key7: 55,
    Key8: 56,
    Key9: 57,
  },
  initialize: async function () {
    return await LgDevice.initialize();
  },
});
