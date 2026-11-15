// Runs a probe in the app over the Chrome DevTools protocol and prints its
// result as JSON. Called by run.sh; see there for usage.
//   node eval.mjs <devtools-websocket-url> <probe.js> <input-json> <timeout-seconds>
//
// With PROBE_PROFILE set to a folder, it also records CPU profiles of the
// page's workers during the probe, and saves them there as .cpuprofile files
// (for Chrome's DevTools, or any reader of the format): one for each worker
// still running when the probe ends, and one for each console.profile() a
// worker ended, as a timed import's does (import.worker.ts), since it ends
// with its import. The workers' code is minified, so names are short; the
// profile's line and column point into the deployed file in dist/. The
// page's own main thread is profiled only between a probe's
// console.profile("name") and console.profileEnd("name"), saved as
// page-<name>.cpuprofile.
//
// With PROBE_CONSOLE set, it also prints the app's errors and warnings to
// stderr, from the app's start on (run.sh restarts it), with uncaught
// exceptions and their stacks: a start that throws shows up here, where the
// tests, which build without the TV's transforms, can miss it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [wsUrl, probeFile, input = "{}", timeoutSeconds = "900"] = process.argv.slice(2);
const showConsole = Boolean(process.env.PROBE_CONSOLE);

// Each probe file declares `async function probe(input)`.
const expression = `${readFileSync(probeFile, "utf8")}\nprobe(${input});`;

const profileDir = process.env.PROBE_PROFILE;

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
// `sessionId` sends to an attached worker instead of the page.
const call = (method, params = {}, sessionId) =>
  new Promise(resolve => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });

// Workers being profiled, by session.
const workers = new Map();
let saved = 0;

const save = (url, profile) => {
  mkdirSync(profileDir, { recursive: true });
  const name = `${++saved}-${path.basename(url).replace(/[^\w.-]/g, "_")}.cpuprofile`;
  writeFileSync(path.join(profileDir, name), JSON.stringify(profile));
  console.error(`Saved ${path.join(profileDir, name)}`);
};

const startProfiling = async (sessionId, targetInfo) => {
  workers.set(sessionId, { url: targetInfo.url, open: true });
  await call("Profiler.enable", {}, sessionId);
  await call("Profiler.setSamplingInterval", { interval: 200 }, sessionId);
  await call("Profiler.start", {}, sessionId);
  await call("Runtime.runIfWaitingForDebugger", {}, sessionId);
  console.error(`Profiling the worker ${targetInfo.url}`);
};

const saveProfiles = async () => {
  if (!profileDir) return;
  for (const [sessionId, worker] of workers) {
    if (!worker.open) continue;
    const { result } = await call("Profiler.stop", {}, sessionId);
    if (result?.profile) save(worker.url, result.profile);
  }
};

ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === "Target.attachedToTarget") {
    const { sessionId, targetInfo } = message.params;
    if (targetInfo.type === "worker") void startProfiling(sessionId, targetInfo);
    else void call("Runtime.runIfWaitingForDebugger", {}, sessionId);
  }
  if (message.method === "Profiler.consoleProfileFinished") {
    const from = message.sessionId ? (workers.get(message.sessionId)?.url ?? "worker") : "page";
    save(message.params.title ? `${from}-${message.params.title}` : from, message.params.profile);
  }
  if (message.method === "Target.detachedFromTarget") {
    const worker = workers.get(message.params.sessionId);
    if (worker) worker.open = false;
  }
  // Probes report progress with console.log("[probe]", ...).
  if (message.method === "Runtime.consoleAPICalled") {
    const [first, ...rest] = message.params.args;
    if (first?.value === "[probe]") console.error(rest.map(arg => arg.value ?? arg.description).join(" "));
    else if (showConsole && (message.params.type === "error" || message.params.type === "warning")) {
      const text = message.params.args.map(arg => arg.value ?? arg.description).join(" ");
      console.error(`[app ${message.params.type}] ${text}`);
    }
  }
  if (showConsole && message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    console.error(`[app exception] ${details.exception?.description ?? details.text}`);
  }
  // What the browser itself reports, such as a script or image that failed to load.
  if (showConsole && message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    console.error(
      `[app log] ${message.params.entry.text}${message.params.entry.url ? ` (${message.params.entry.url})` : ""}`,
    );
  }
});

ws.addEventListener("open", async () => {
  await call("Runtime.enable");
  if (showConsole) await call("Log.enable");
  // Lets the app finish starting. The debug port opens before the app's
  // page loads, and a probe run in the page before it reads and writes a
  // different storage, so this waits for the app's probe hooks (at most
  // 20 s), then a little longer for the start to settle.
  for (let waited = 0; waited < 20_000; waited += 200) {
    const ready = await call("Runtime.evaluate", {
      expression: "document.readyState === 'complete' && window.velio !== undefined",
      returnByValue: true,
    });
    if (ready.result?.result?.value === true) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await new Promise(resolve => setTimeout(resolve, 1500));
  // Workers wait to start until their profiler runs. The page itself is
  // profiled between a probe's console.profile() and console.profileEnd().
  if (profileDir) {
    await call("Profiler.enable");
    await call("Profiler.setSamplingInterval", { interval: 250 });
    await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }
  const { result } = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  await saveProfiles();
  if (result?.exceptionDetails) {
    console.error(
      "The probe threw:",
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
    process.exit(1);
  }
  console.log(JSON.stringify(result?.result?.value, null, 2));
  process.exit(0);
});

// The page closing (the app quit or was killed) ends the probe.
const started = Date.now();
ws.addEventListener("close", event => {
  const seconds = Math.round((Date.now() - started) / 1000);
  console.error(`The app's page closed the connection after ${seconds} s (code ${event.code}).`);
  process.exit(1);
});

setTimeout(
  () => {
    console.error(`The probe didn't finish within ${timeoutSeconds} s.`);
    process.exit(1);
  },
  Number(timeoutSeconds) * 1000,
);
