import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import hexColorTransform from "@lightningtv/vite-hex-transform";
import legacy from "@vitejs/plugin-legacy";
import path from "path";
import { existsSync } from "fs";
import { playwright } from "@vitest/browser-playwright";
import deviceConfigPlugin from "./devices/deviceConfigPlugin.js";
import { lowerChunks, workerPolyfills } from "./scripts/build/oldTvs.mjs";

const envDir = "./environments";
// webOS 3's Chromium; Tizen 3 has 47.
const OLDEST_CHROME = "chrome >= 38";

// The TV to build for, such as tizen or lg. Its folder in devices/ supplies
// the `#device` import: that TV's keys, player and settings.
const targetDevice = process.env.TARGET_DEVICE || "common";
const deviceDir = path.resolve(import.meta.dirname, "./devices", targetDevice);
if (!existsSync(deviceDir)) {
  throw new Error(`Unknown TARGET_DEVICE "${targetDevice}": ${deviceDir} doesn't exist.`);
}

export default defineConfig(({ mode }) => {
  // Get environment variables
  // const env = loadEnv(mode, path.join(__dirname, envDir));

  return {
    envDir,
    define: {
      __DEV__: mode !== "production",
    },
    plugins: [
      deviceConfigPlugin(targetDevice),
      hexColorTransform({
        include: ["src/**/*.{ts,tsx,js,jsx}"],
      }),
      solidPlugin({
        solid: {
          moduleName: "@solidtv/solid",
          generate: "universal",
        },
      }),
      // The oldest TVs supported are webOS 3 (Chromium 38) and Tizen 3
      // (Chromium 47), without modules, so they load the legacy build
      // (SystemJS, ES5, with the polyfills the code uses), as does any
      // browser without the modern build's features. Workers are built
      // apart; see worker.plugins (PLAN.md, Phase 8, step 4).
      legacy({
        targets: [OLDEST_CHROME],
      }),
      lowerChunks({ targets: [OLDEST_CHROME], include: /-legacy-/ }),
    ],
    // Classic workers (old TVs have no module workers), in ES5 with the
    // polyfills they use.
    worker: {
      format: "iife",
      plugins: () => [
        workerPolyfills({ targets: [OLDEST_CHROME] }),
        lowerChunks({ targets: [OLDEST_CHROME], include: /./ }),
      ],
    },
    build: {
      // The modern build runs only where modulepreload exists (Chromium
      // 105+). The polyfill also lands in the legacy build, where it fetched
      // the modern build's preloads, and failed without fetch (Chromium 38).
      modulePreload: { polyfill: false },
    },
    resolve: {
      alias: {
        theme: path.resolve(import.meta.dirname, "./theme.js"),
        "@": path.resolve(import.meta.dirname, "./src"),
        "#devices": path.resolve(import.meta.dirname, "./devices"),
        "#device": deviceDir,
      },
      dedupe: ["solid-js", "@solidtv/solid", "@solidtv/renderer"],
    },
    optimizeDeps: {
      exclude: ["@solidtv/solid", "@solidtv/renderer"],
    },
    server: {
      hmr: true,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    test: {
      browser: {
        enabled: true,
        // Shows the browser locally; CI sets CI=true and runs headless.
        headless: Boolean(process.env.CI),
        provider: playwright(),
        instances: [{ browser: "webkit" }],
      },
      testTransformMode: { web: ["/.[jt]sx?$/"] },
      globals: true,
    },
  };
});
