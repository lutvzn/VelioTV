// The Web Worker that runs imports, so parsing and storing never hold up the
// UI. Start it through importClient.ts.

// A worker's postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin

import { runImport, type ImportProgress, type ImportRequest, type ImportResult } from "./importer";

export type WorkerMessage =
  | { type: "progress"; progress: ImportProgress }
  | { type: "done"; result: ImportResult }
  | { type: "error"; message: string };

const send = (message: WorkerMessage) => self.postMessage(message);

// IndexedDB errors are DOMExceptions, often with an empty message, so the
// name matters too.
const describe = (error: unknown) => {
  if (error && typeof error === "object" && "name" in error && "message" in error) {
    return `${String(error.name)}: ${String(error.message) || "(no message)"}`;
  }
  return String(error);
};

// A timed import is also a CPU profile, for the DevTools protocol (the probe
// runner's PROBE_PROFILE), ended before the worker is: without DevTools,
// console.profile() does nothing. TypeScript's types lack it.
declare global {
  interface Console {
    profile?: (label?: string) => void;
    profileEnd?: (label?: string) => void;
  }
}
const profiling = (request: ImportRequest) => request.timing === true;

const handle = async (request: ImportRequest) => {
  if (profiling(request)) console.profile?.("import");
  let message: WorkerMessage;
  try {
    const result = await runImport(request, { onProgress: progress => send({ type: "progress", progress }) });
    message = { type: "done", result };
  } catch (error) {
    message = { type: "error", message: describe(error) };
  }
  if (profiling(request)) console.profileEnd?.("import");
  send(message);
};

self.addEventListener("message", (event: MessageEvent<ImportRequest>) => void handle(event.data));
