// Build plugins for the oldest TVs supported (PLAN.md, Key decisions), used
// in vite.config.js. @vitejs/plugin-legacy makes an ES5 build of the page's
// scripts, with polyfills, but:
//
// - it doesn't reach workers, which Vite builds once: workerPolyfills() adds
//   to each worker module imports of the core-js polyfills it uses (Babel's
//   useBuiltIns: "usage");
// - the minifier, which runs after it, brings back newer syntax (template
//   strings for quotes, arrow functions in the bundler's helpers):
//   lowerChunks() lowers finished chunks to the targets' syntax again, after
//   minifying, for the legacy chunks and the workers.

import { transformAsync } from "@babel/core";

const SCRIPT = /\.[cm]?[jt]sx?$/;
// core-js polyfills itself, and must not import itself.
const SKIP = /[\\/]node_modules[\\/](core-js|@babel[\\/]runtime|regenerator-runtime)[\\/]/;

const presetEnv = (targets, options = {}) => [
  "@babel/preset-env",
  { targets, bugfixes: true, modules: false, ...options },
];

/** Adds the core-js polyfills each module uses. For worker.plugins. */
export const workerPolyfills = ({ targets }) => ({
  name: "tiviplayer:worker-polyfills",
  async transform(code, id) {
    const file = id.split("?")[0];
    if (!SCRIPT.test(file) || SKIP.test(file) || file.includes("\0")) return null;
    const result = await transformAsync(code, {
      filename: file,
      babelrc: false,
      configFile: false,
      sourceType: "unambiguous",
      sourceMaps: true,
      presets: [presetEnv(targets, { useBuiltIns: "usage", corejs: "3.50" })],
    });
    return result && { code: result.code ?? code, map: result.map };
  },
});

/**
 * Lowers the finished chunks whose file names `include` matches to the
 * targets' syntax, after minifying. Their source maps no longer match.
 */
export const lowerChunks = ({ targets, include }) => ({
  name: "tiviplayer:lower-chunks",
  enforce: "post",
  generateBundle: {
    order: "post",
    async handler(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !include.test(chunk.fileName)) continue;
        const result = await transformAsync(chunk.code, {
          filename: chunk.fileName,
          babelrc: false,
          configFile: false,
          sourceType: "script",
          compact: true,
          comments: false,
          // Only the syntax: the chunks were compiled for the targets before.
          // Rewriting `typeof x == "object"` again would also reach core-js,
          // which then takes its own Symbols for symbols, not objects, and
          // fails where it replaced the browser's Symbol (Chromium 38).
          presets: [presetEnv(targets, { exclude: ["transform-typeof-symbol"] })],
        });
        if (result?.code) chunk.code = result.code;
      }
    },
  },
});
