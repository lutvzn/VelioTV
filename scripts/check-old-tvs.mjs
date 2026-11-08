#!/usr/bin/env node
// Checks a build for the oldest TVs supported, Tizen 5.5 (Chromium 69) and
// webOS 5 (Chromium 68), as no such TV is at hand (PLAN.md, Phase 8, step 4):
//
//   node scripts/check-old-tvs.mjs [build folder, default dist/tizen]
//
// Every script must parse without syntax newer than Chromium 68: no `?.`,
// `??`, class fields, `export * as`, or anything else after ES2020's
// `import()` and `import.meta`, which Chromium 63 and 64 have. The main
// thread gets polyfills from @vitejs/plugin-legacy, but the workers don't, so
// they must not use the newer built-ins listed below either.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "acorn";

const dir = process.argv[2] ?? "dist/tizen";

// Built-ins newer than Chromium 68, by the name they're used under.
const NEWER_GLOBALS = new Set([
  "globalThis",
  "queueMicrotask",
  "structuredClone",
  "AggregateError",
  "WeakRef",
  "FinalizationRegistry",
]);
const NEWER_MEMBERS = new Set([
  "fromEntries",
  "flat",
  "flatMap",
  "matchAll",
  "allSettled",
  "any",
  "replaceAll",
  "at",
  "findLast",
  "findLastIndex",
  "hasOwn",
  "randomUUID",
  "toSorted",
  "toReversed",
  "toSpliced",
  "timeout",
  "throwIfAborted",
]);

const scripts = folder =>
  readdirSync(folder).flatMap(name => {
    const file = path.join(folder, name);
    if (statSync(file).isDirectory()) return scripts(file);
    return name.endsWith(".js") ? [file] : [];
  });

// Each node of a syntax tree.
function* nodes(node) {
  if (!node || typeof node.type !== "string") return;
  yield node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) yield* nodes(item);
    else if (value && typeof value === "object") yield* nodes(value);
  }
}

const newerSyntax = node => {
  if (node.type === "ChainExpression") return "optional chaining (?.)";
  if (node.type === "LogicalExpression" && node.operator === "??") return "nullish coalescing (??)";
  if (node.type === "ExportAllDeclaration" && node.exported) return "export * as";
  return undefined;
};

const newerBuiltIn = node => {
  if (node.type === "Identifier" && NEWER_GLOBALS.has(node.name)) return node.name;
  if (node.type === "MemberExpression" && !node.computed && NEWER_MEMBERS.has(node.property.name))
    return `.${node.property.name}`;
  return undefined;
};

const files = scripts(dir);
if (files.length === 0) {
  console.error(`No scripts in ${dir}: build it first.`);
  process.exit(1);
}
const problems = [];
for (const file of files) {
  const code = readFileSync(file, "utf8");
  const worker = path.basename(file).includes(".worker-");
  const where = pos => `${file}: ${JSON.stringify(code.slice(Math.max(0, pos - 40), pos + 40))}`;
  let tree;
  try {
    tree = parse(code, { ecmaVersion: 2020, sourceType: worker ? "script" : "module" });
  } catch (error) {
    problems.push(`${error.message}, newer than Chromium 68 can read, at ${where(error.pos)}`);
    continue;
  }
  const found = new Map();
  for (const node of nodes(tree)) {
    const what = newerSyntax(node) ?? (worker ? newerBuiltIn(node) : undefined);
    if (what && !found.has(what)) found.set(what, node.start);
  }
  for (const [what, pos] of found) problems.push(`${what} at ${where(pos)}`);
}

if (problems.length > 0) {
  console.error(`Not for Chromium 68 (${problems.length}):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`${files.length} scripts in ${dir} are fine for Chromium 68.`);
