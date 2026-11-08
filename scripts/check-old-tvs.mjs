#!/usr/bin/env node
// Checks a build for the oldest TVs supported, webOS 3 (Chromium 38) and
// Tizen 3 (Chromium 47), as no such TV is at hand (PLAN.md, Phase 8, step 4):
//
//   node scripts/check-old-tvs.mjs [build folder, default dist/tizen]
//
// TVs without the modern build's features (import.meta.resolve, so up to
// Chromium 104) run the legacy build (@vitejs/plugin-legacy) and the workers,
// which must be ES5: no let or const, arrow functions, classes, template
// strings, generators, and so on. The modern build only runs on newer
// browsers, so it isn't checked. Polyfills, and APIs no polyfill gives, are
// checked by running the build in an old Chromium (scripts/old-chrome/).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "acorn";

const dir = process.argv[2] ?? "dist/tizen";

const scripts = folder =>
  readdirSync(folder).flatMap(name => {
    const file = path.join(folder, name);
    if (statSync(file).isDirectory()) return scripts(file);
    return name.endsWith(".js") ? [file] : [];
  });

const all = scripts(dir);
const forOldTvs = all.filter(file => /-legacy-|\.worker-/.test(path.basename(file)));
const workers = forOldTvs.filter(file => path.basename(file).includes(".worker-"));
if (forOldTvs.length === 0 || workers.length === 0) {
  console.error(`No legacy scripts or workers in ${dir}: build it first.`);
  process.exit(1);
}
const problems = [];
for (const file of forOldTvs) {
  const code = readFileSync(file, "utf8");
  try {
    parse(code, { ecmaVersion: 5, sourceType: "script" });
  } catch (error) {
    const near = JSON.stringify(code.slice(Math.max(0, error.pos - 40), error.pos + 40));
    problems.push(`${file}: ${error.message}, not ES5, at ${near}`);
  }
}

if (problems.length > 0) {
  console.error(`Not for old TVs (${problems.length}):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`${forOldTvs.length} legacy scripts and workers in ${dir} are ES5.`);
