import { Plugin } from "vite";

// Sets the output folder for TARGET_DEVICE. vite.config.js points the
// `#device` import at that device's folder.
export default (device = "common"): Plugin => ({
  name: "device-config",
  enforce: "pre",
  config: config => {
    config.build = config.build ?? {};
    config.build.outDir ??= `dist/${device}`;
    // Relative, because packaged TV apps load from the app's own folder.
    config.base ??= "./";
  },
});
