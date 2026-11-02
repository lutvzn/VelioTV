import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import hexColorTransform from "@lightningtv/vite-hex-transform";
import legacy from "@vitejs/plugin-legacy";
import path from "path";
import { existsSync } from "fs";
import { playwright } from "@vitest/browser-playwright";
import deviceConfigPlugin from "./devices/deviceConfigPlugin.js";

const envDir = "./environments";

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
      legacy({
        targets: ["defaults", "Chrome >= 49"],
        // additionalLegacyPolyfills: ["whatwg-fetch", "es6-proxy-polyfill"],
        modernPolyfills: [
          // Safari 11 has modules, but throws > ReferenceError: Can't find variable: globalThis
          "es.global-this",
        ],
      }),
    ],
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
