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

self.addEventListener("message", (event: MessageEvent<ImportRequest>) => {
  runImport(event.data, { onProgress: progress => send({ type: "progress", progress }) }).then(
    result => send({ type: "done", result }),
    (error: unknown) => send({ type: "error", message: describe(error) }),
  );
});
