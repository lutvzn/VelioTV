#!/usr/bin/env node
// Runs a build of the app in an old headless Chromium, as no TV that old is
// at hand (PLAN.md, Phase 8, step 4). It serves the build, opens it, prints
// every exception and console message from the start, waits for the app,
// runs a probe in it and saves a screenshot.
//
//   node scripts/old-chrome/run.mjs <chrome> [build] [probe.js] [input-json]
//
//   chrome     the browser, from scripts/old-chrome/get.sh
//   build      a build folder, default dist/common (TARGET_DEVICE=common pnpm build)
//   probe.js   default scripts/old-chrome/smoke.js; probes run as written, so
//              in Chromium 69 they can't use ?. or ?? (the tv-probe ones do)
//
// The screenshot goes to old-chrome.png in the build folder's parent. The
// smoke probe needs `pnpm test-streams` running on this machine.
// It exits 1 if the page threw, the app didn't start, or the probe failed.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const [chrome, build = "dist/common", probeFile = path.join(here, "smoke.js"), input = "{}"] =
  process.argv.slice(2);
if (!chrome) {
  console.error("usage: node scripts/old-chrome/run.mjs <chrome> [build] [probe.js] [input-json]");
  process.exit(2);
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const root = path.resolve(build);
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(root, name === "/" ? "index.html" : name);
  try {
    if (!file.startsWith(root)) throw new Error("outside the build");
    const body = readFileSync(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const profile = mkdtempSync(path.join(tmpdir(), "old-chrome-"));
const browser = spawn(
  chrome,
  [
    "--headless",
    "--no-sandbox",
    "--use-gl=swiftshader",
    "--window-size=1920,1080",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const finish = code => {
  browser.kill();
  server.close();
  rmSync(profile, { recursive: true, force: true });
  process.exit(code);
};
const debuggerUrl = await new Promise((resolve, reject) => {
  let text = "";
  browser.stderr.on("data", chunk => {
    text += chunk;
    const found = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (found) resolve(found[1]);
  });
  browser.on("error", reject);
  browser.on("exit", code => reject(new Error(`the browser exited (${code}): ${text}`)));
});
const pages = await (await fetch(`http://127.0.0.1:${new URL(debuggerUrl).port}/json`)).json();
const ws = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener("open", resolve));

let nextId = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise(resolve => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
let threw = 0;
ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  const { method, params } = message;
  if (method === "Runtime.exceptionThrown") {
    threw++;
    const details = params.exceptionDetails;
    console.error(at(), "EXCEPTION", details.exception?.description ?? details.text, details.url ?? "");
  } else if (method === "Runtime.consoleAPICalled") {
    const args = params.args.map(arg => String(arg.value ?? arg.description ?? arg.type).slice(0, 300));
    console.error(at(), `console.${params.type}`, ...args);
  } else if (method === "Log.entryAdded") {
    console.error(at(), `log.${params.entry.level}`, params.entry.text.slice(0, 300), params.entry.url ?? "");
  }
});
await call("Runtime.enable");
await call("Log.enable");
const version = await call("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
console.error(at(), version.result.result.value);
await call("Page.navigate", { url });

let ready = false;
for (let waited = 0; waited < 20_000 && !ready; waited += 250) {
  const check = await call("Runtime.evaluate", {
    expression: "document.readyState === 'complete' && window.tiviplayer !== undefined",
    returnByValue: true,
  });
  ready = check.result?.result?.value === true;
  if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
}
console.error(at(), ready ? "the app started" : "the app didn't start in 20 s");
let failed = !ready || threw > 0;
if (ready) {
  await new Promise(resolve => setTimeout(resolve, 2000));
  const expression = `${readFileSync(probeFile, "utf8")}\nprobe(${input});`;
  const { result } = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result?.exceptionDetails) {
    failed = true;
    console.error(
      at(),
      "the probe threw:",
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  } else {
    const value = result?.result?.value;
    if (value?.error) failed = true;
    console.log(JSON.stringify(value, null, 2));
  }
}
const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const file = path.join(path.dirname(root), "old-chrome.png");
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.error(at(), "screenshot:", file);
}
finish(failed || threw > 0 ? 1 : 0);
