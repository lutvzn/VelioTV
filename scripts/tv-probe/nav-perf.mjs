#!/usr/bin/env node
// Catches navigation slowdowns on the TV (PLAN.md, "Navigation speed"): runs
// the nav-perf probe in the installed app and compares each number with the
// one kept in baselines/nav-perf.json.
//
//   node scripts/tv-probe/nav-perf.mjs <tv-ip>            run and compare
//   node scripts/tv-probe/nav-perf.mjs <tv-ip> --save     run and keep as the baseline
//   node scripts/tv-probe/nav-perf.mjs --from <result.json> [--save]
//                                                         compare (or keep) a saved run
//
// A run takes about 105 s. A TV's numbers vary from run to run, so when one
// is worse than the baseline allows, the probe runs once more and each
// number counts at the better of the two: only what's slow both times is
// reported. It exits with 1 when something is slower. Deploy the build to
// test first (pnpm deploy:tizen <tv-ip>); the test sources must be loaded
// (pnpm test-streams), as for the baseline.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, "baselines", "nav-perf.json");

const args = process.argv.slice(2);
const save = args.includes("--save");
const fromAt = args.indexOf("--from");
const from = fromAt >= 0 ? args[fromAt + 1] : undefined;
const tv = args.find((one, i) => !one.startsWith("--") && (fromAt < 0 || i !== fromAt + 1));
if (!tv && !from) {
  console.error(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 18)
      .join("\n"),
  );
  process.exit(2);
}

const run = () => {
  console.error("Running nav-perf on the TV (about 105 s)…");
  const out = spawnSync(join(here, "run.sh"), [tv, "nav-perf", "{}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1e8,
  });
  if (out.status !== 0) {
    console.error(`The probe failed (exit ${out.status}).`);
    process.exit(2);
  }
  const result = JSON.parse(out.stdout);
  if (!result.done) {
    console.error("The probe gave no result:", out.stdout.slice(0, 2000));
    process.exit(2);
  }
  return result.done;
};

/**
 * How far each kind of number may move before it counts as slower: by a
 * share of the baseline, and at least by an amount, as small numbers
 * jitter by a few ms. Higher is worse, except for fps. The numbers of one
 * moment (the highest, the longest frame, how long until all is still)
 * vary too much between runs of the same build, as posters and the guide
 * load behind: they're shown as notes, and only the steady ones fail.
 */
const allowance = (name, field) => {
  const once = name.startsWith("open-") || name.endsWith("Open") || name.endsWith("Back");
  if (field === "fps") return { lowerIsWorse: true, share: 0.1, least: 3 };
  if (field === "presses" || field === "readyMs" || field === "capped" || field === "moved") return undefined;
  if (field === "framesOver50ms") return { share: 0.5, least: 3 };
  if (field === "framesOver20ms") return { share: 0.5, least: 6, note: true };
  if (field.startsWith("settle")) return { share: 0.5, least: 200, note: true };
  if (field.endsWith("Max") || field === "longestFrameMs") return { share: 0.5, least: 50, note: true };
  // A key's frame comes up to a refresh later, by where it falls between
  // two; an open is timed once, so it has more room.
  if (field.startsWith("frame")) return once ? { share: 0.35, least: 40 } : { share: 0.25, least: 20 };
  return { share: 0.25, least: once ? 15 : 8 };
};

const numbers = result => {
  const out = new Map();
  for (const [step, value] of Object.entries(result.steps ?? {})) {
    if (typeof value !== "object") continue;
    for (const [field, number] of Object.entries(value)) {
      const counted = typeof number === "boolean" ? Number(number) : number;
      if (typeof counted === "number") out.set(`${step}.${field}`, counted);
    }
  }
  for (const [name, count] of Object.entries(result.screens ?? {})) out.set(`screens.${name}`, count);
  if (typeof result.heapMB === "number") out.set("heapMB", result.heapMB);
  return out;
};

const allowed = key => {
  if (key.startsWith("screens.")) return { share: 0.1, least: 5 };
  if (key === "heapMB") return { share: 0.2, least: 5 };
  const dot = key.lastIndexOf(".");
  return allowance(key.slice(0, dot), key.slice(dot + 1));
};

const compare = (base, now) => {
  const slower = [];
  const missing = [];
  const notes = [];
  for (const [key, was] of base) {
    const rule = allowed(key);
    if (!rule) continue;
    const is = now.get(key);
    if (is === undefined) {
      missing.push(key);
      continue;
    }
    const room = Math.max(Math.abs(was) * rule.share, rule.least);
    const worse = rule.lowerIsWorse ? was - is > room : is - was > room;
    if (worse) (rule.note ? notes : slower).push({ key, was, is, room: Math.round(room * 10) / 10 });
  }
  return { slower, missing, notes };
};

/** Each number at the better of two runs. */
const better = (a, b) => {
  const out = new Map(a);
  for (const [key, value] of b) {
    const had = out.get(key);
    const rule = allowed(key);
    if (had === undefined) out.set(key, value);
    else out.set(key, rule?.lowerIsWorse ? Math.max(had, value) : Math.min(had, value));
  }
  return out;
};

const first = from ? JSON.parse(readFileSync(from, "utf8")) : run();
const result = first.done ?? first;
if (save) {
  writeFileSync(baselinePath, `${JSON.stringify(result, undefined, 2)}\n`);
  console.log(`Saved as the baseline: ${baselinePath}`);
  process.exit(0);
}
if (!existsSync(baselinePath)) {
  console.error(`No baseline yet: run with --save first (${baselinePath}).`);
  process.exit(2);
}
const base = numbers(JSON.parse(readFileSync(baselinePath, "utf8")));
let now = numbers(result);
let { slower, missing, notes } = compare(base, now);
if (slower.length > 0 && !from) {
  console.error(`${slower.length} slower than the baseline; running once more to be sure.`);
  now = better(now, numbers(run()));
  ({ slower, missing, notes } = compare(base, now));
}

const row = one =>
  `${one.key.padEnd(34)} ${String(one.was).padStart(8)} → ${String(one.is).padEnd(8)} (allowed ±${one.room})`;
for (const one of notes) console.log(`note      ${row(one)}`);
for (const key of missing) console.log(`missing   ${key} (a step that didn't run)`);
for (const one of slower) console.log(`SLOWER    ${row(one)}`);
// What got clearly faster, so the baseline can be saved again.
let faster = 0;
for (const [key, was] of base) {
  const rule = allowed(key);
  const is = now.get(key);
  if (!rule || rule.note || is === undefined) continue;
  const room = Math.max(Math.abs(was) * rule.share, rule.least);
  if (rule.lowerIsWorse ? is - was > room : was - is > room) faster++;
}
if (slower.length === 0) console.log(`No slowdowns against the baseline (${base.size} numbers).`);
if (faster > 0) console.log(`${faster} numbers are clearly faster: --save keeps them as the baseline.`);
process.exit(slower.length > 0 || missing.length > 0 ? 1 : 0);
