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
//   probe.js   default scripts/old-chrome/smoke.js; it is compiled down to
//              what the browser reads (Babel), so it can use async and ?.
//
// Chromium 47 (Tizen 3) and 38 (webOS 3) need GConf and GTK 2, and have no
// headless mode, so they run in the old-chrome box (distrobox.ini) on a
// virtual screen: set OLD_CHROME_BOX=old-chrome. This works from the host
// and from the tv-dev box. Newer ones run headless where this runs.
//
// The screenshot goes to old-chrome.png in the build folder's parent. The
// smoke probe needs `pnpm test-streams` running on this machine.
// It exits 1 if the page threw, the app didn't start, or the probe failed.

import { transformAsync } from "@babel/core";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;

// A free port for the browser's debugger, as the oldest can't pick one and say.
const port = await new Promise(resolve => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const free = probe.address().port;
    probe.close(() => resolve(free));
  });
});
// In the build folder's parent, which the old-chrome box sees too.
const profile = mkdtempSync(path.join(path.dirname(root), ".old-chrome-"));
const flags = [
  "--no-sandbox",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1920,1080",
  "--window-position=0,0",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  "about:blank",
];
const box = process.env.OLD_CHROME_BOX;
const inBox = path.join(here, "in-box.sh");
const [command, ...launchArgs] = !box
  ? [chrome, "--headless", "--use-gl=swiftshader", ...flags]
  : existsSync("/run/.containerenv")
    ? [
        "distrobox-host-exec",
        "distrobox",
        "enter",
        "-T",
        box,
        "--",
        inBox,
        chrome,
        "--ignore-gpu-blacklist",
        ...flags,
      ]
    : ["distrobox", "enter", "-T", box, "--", inBox, chrome, "--ignore-gpu-blacklist", ...flags];
const browser = spawn(command, launchArgs, { stdio: ["ignore", "ignore", "pipe"] });
// The box's launcher stops the browser when the profile goes.
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
let browserLog = "";
browser.stderr.on("data", chunk => (browserLog = (browserLog + chunk).slice(-4000)));
let exited = false;
const exit = new Promise(resolve => browser.on("exit", resolve)).then(() => (exited = true));
let page;
const finish = async code => {
  // Closing its only tab ends a browser on a screen. It saves its profile
  // as it goes, so the profile is removed once it has.
  if (page) await fetch(`http://127.0.0.1:${port}/json/close/${page.id}`).catch(() => undefined);
  if (!box) browser.kill();
  await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 10_000))]);
  if (!exited) browser.kill();
  server.close();
  rmSync(profile, { recursive: true, force: true });
  process.exit(code);
};
const debuggerGet = async what => (await fetch(`http://127.0.0.1:${port}/json${what}`)).json();
for (let waited = 0; !page; waited += 250) {
  if (exited || waited > 120_000) {
    console.error(
      exited ? "the browser exited:" : "the browser's debugger didn't answer in 2 minutes:",
      browserLog,
    );
    await finish(1);
  }
  page = await debuggerGet("")
    .then(list => list.find(target => target.type === "page"))
    .catch(() => undefined);
  if (!page) await new Promise(resolve => setTimeout(resolve, 250));
}
// Chromium before 55 reports console messages and exceptions only through
// the Console domain, and evaluates without awaiting a promise.
const major = Number(/Chrome\/(\d+)/.exec((await debuggerGet("/version")).Browser)?.[1] ?? 0);
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
// Exceptions, by where they came from. A browser without the modern build's
// features (up to Chromium 104) fails it on purpose, then loads the legacy
// build, saying so ("vite: loading legacy chunks"); those don't count.
// Before Chromium 61 the modern build doesn't run at all.
const exceptions = [];
let legacy = major < 61;
const counted = () =>
  exceptions.filter(url => !(legacy && (url.startsWith("data:") || !/-legacy-|\.worker-/.test(url)))).length;
ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  const { method, params } = message;
  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails;
    exceptions.push(details.url ?? "");
    console.error(at(), "EXCEPTION", details.exception?.description ?? details.text, details.url ?? "");
  } else if (method === "Runtime.consoleAPICalled") {
    const args = params.args.map(arg => String(arg.value ?? arg.description ?? arg.type).slice(0, 300));
    if (args[0]?.startsWith("vite: loading legacy chunks")) legacy = true;
    console.error(at(), `console.${params.type}`, ...args);
  } else if (method === "Log.entryAdded") {
    console.error(at(), `log.${params.entry.level}`, params.entry.text.slice(0, 300), params.entry.url ?? "");
  } else if (method === "Console.messageAdded") {
    const { source, level, text, url = "", line, parameters = [] } = params.message;
    const values = parameters
      .slice(1)
      .map(arg => String(arg.value ?? arg.description ?? arg.type).slice(0, 300));
    // Uncaught exceptions come from "javascript"; console calls from "console-api".
    if (source === "javascript" && level === "error") exceptions.push(url);
    if (text.startsWith("vite: loading legacy chunks")) legacy = true;
    console.error(at(), `${source}.${level}`, text.slice(0, 300), ...values, url ? `${url}:${line}` : "");
    // Logged errors' stacks, which the old protocol leaves out.
    for (const arg of parameters) {
      if (!arg.objectId || !(arg.className ?? "").endsWith("Error")) continue;
      void call("Runtime.callFunctionOn", {
        objectId: arg.objectId,
        functionDeclaration: "function () { return String(this.stack); }",
        returnByValue: true,
      }).then(stack => console.error(at(), "  stack:", String(stack.result?.result?.value).slice(0, 1500)));
    }
  }
});
await call("Runtime.enable");
await call(major < 55 ? "Console.enable" : "Log.enable");
const version = await call("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
console.error(at(), version.result.result.value);
await call("Page.navigate", { url: pageUrl });

let ready = false;
for (let waited = 0; waited < 20_000 && !ready; waited += 250) {
  const check = await call("Runtime.evaluate", {
    expression: "document.readyState === 'complete' && window.velio !== undefined",
    returnByValue: true,
  });
  ready = check.result?.result?.value === true;
  if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
}
console.error(at(), ready ? "the app started" : "the app didn't start in 20 s");
let failed = !ready;
if (ready) {
  await new Promise(resolve => setTimeout(resolve, 2000));
  // The probe's answer lands in a global that this reads until it's there.
  const source = `${readFileSync(probeFile, "utf8")}
window.__oldChrome = {};
Promise.resolve().then(() => probe(${input})).then(
  value => (window.__oldChrome.value = value === undefined ? null : value),
  error => (window.__oldChrome.threw = String((error && error.stack) || error)),
);`;
  const compiled = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    sourceType: "script",
    presets: [["@babel/preset-env", { targets: `chrome ${major || 38}`, modules: false }]],
  });
  const launched = await call("Runtime.evaluate", { expression: compiled.code });
  const startError =
    launched.result?.exceptionDetails ?? (launched.result?.wasThrown && launched.result.result);
  let answer = startError
    ? { threw: startError.exception?.description ?? startError.description ?? startError.text }
    : {};
  for (let waited = 0; !("value" in answer) && !("threw" in answer); waited += 250) {
    if (waited > 600_000) answer = { threw: "no answer in 10 minutes" };
    await new Promise(resolve => setTimeout(resolve, 250));
    const read = await call("Runtime.evaluate", {
      expression: "JSON.stringify(window.__oldChrome)",
      returnByValue: true,
    });
    answer = { ...answer, ...JSON.parse(read.result?.result?.value ?? "{}") };
  }
  if ("threw" in answer) {
    failed = true;
    console.error(at(), "the probe threw:", answer.threw);
  } else {
    if (answer.value?.error) failed = true;
    console.log(JSON.stringify(answer.value, null, 2));
  }
}
const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const file = path.join(path.dirname(root), "old-chrome.png");
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.error(at(), "screenshot:", file);
}
if (legacy) console.error(at(), "ran the legacy build");
const threw = counted();
if (threw > 0) console.error(at(), `${threw} exception(s)`);
await finish(failed || threw > 0 ? 1 : 0);
