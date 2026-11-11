#!/usr/bin/env node
// Copies Velio Sync's shared code (VelioPlatform's packages/sync-core) into
// src/sync-core/, as VelioPlatform has no remote VelioTV's CI could fetch it
// from (SYNC-PLAN.md, step 1):
//
//   node scripts/sync-core/copy.mjs            copy again
//   node scripts/sync-core/copy.mjs --check    fail if the copy differs
//
// Change sync-core only in VelioPlatform, run its checks there, then copy
// again; never edit src/sync-core/ by hand. Each file gets a header naming
// where it came from, and its "./x.ts" imports become "./x", as VelioTV's
// tsconfig doesn't take ".ts" extensions. login.ts (Argon2id, which TVs
// never run) and export.ts (the owner's export) are left out.
//
// --check is quiet when VelioPlatform isn't next to this repo, as in CI.
// VELIO_PLATFORM sets where it is.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const platform = path.resolve(process.env.VELIO_PLATFORM ?? path.join(root, "../VelioPlatform"));
const from = path.join(platform, "packages/sync-core/src");
const to = path.join(root, "src/sync-core");
const LEFT_OUT = new Set(["login.ts", "export.ts"]);
const check = process.argv.includes("--check");

if (!existsSync(from)) {
  if (check) {
    console.log(`No VelioPlatform at ${platform}: the copy isn't checked.`);
    process.exit(0);
  }
  console.error(`No sync-core at ${from}. Set VELIO_PLATFORM to VelioPlatform's folder.`);
  process.exit(1);
}

const header = name =>
  `// Copied from VelioPlatform's packages/sync-core/src/${name} by\n` +
  `// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.\n\n`;

// What a copied file holds: its header, then the source with its imports rewritten.
const copyOf = (name, source) => {
  const body = source
    // Lines that export a left-out file (index.ts).
    .split("\n")
    .filter(line => ![...LEFT_OUT].some(file => line.includes(`"./${file}"`)))
    .join("\n")
    .replace(/(from\s+"\.\/[\w-]+)\.ts"/g, '$1"');
  return header(name) + body;
};

const wanted = new Map(
  readdirSync(from)
    .filter(name => name.endsWith(".ts") && !LEFT_OUT.has(name))
    .toSorted()
    .map(name => [name, copyOf(name, readFileSync(path.join(from, name), "utf8"))]),
);

const present = existsSync(to) ? readdirSync(to).filter(name => name.endsWith(".ts")) : [];
const differ = [
  ...[...wanted]
    .filter(
      ([name, text]) =>
        !existsSync(path.join(to, name)) || readFileSync(path.join(to, name), "utf8") !== text,
    )
    .map(([name]) => name),
  ...present.filter(name => !wanted.has(name)),
];

if (check) {
  if (differ.length > 0) {
    console.error(
      `src/sync-core/ differs from ${from}: ${differ.join(", ")}.\n` +
        "Run node scripts/sync-core/copy.mjs (and never edit the copy by hand).",
    );
    process.exit(1);
  }
  console.log(`src/sync-core/ matches VelioPlatform (${wanted.size} files).`);
  process.exit(0);
}

mkdirSync(to, { recursive: true });
for (const name of present) if (!wanted.has(name)) rmSync(path.join(to, name));
for (const [name, text] of wanted) writeFileSync(path.join(to, name), text);
console.log(
  `Copied ${wanted.size} files to src/sync-core/${differ.length ? ` (changed: ${differ.join(", ")})` : ""}.`,
);
