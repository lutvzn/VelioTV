// Starts an import in its own Web Worker, from the UI thread.

// A worker's postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin

import type { ImportProgress, ImportRequest, ImportResult } from "./importer";
import type { WorkerMessage } from "./import.worker";
// Vite bundles the worker; oxlint can't resolve the "?worker" import.
// oxlint-disable-next-line import/default
import ImportWorker from "./import.worker?worker";

export type { ImportProgress, ImportRequest, ImportResult };

export const importSource = (request: ImportRequest, onProgress?: (progress: ImportProgress) => void) =>
  new Promise<ImportResult>((resolve, reject) => {
    const worker = new ImportWorker();
    worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.progress);
        return;
      }
      worker.terminate();
      if (message.type === "done") resolve(message.result);
      else reject(new Error(message.message));
    });
    worker.addEventListener("error", event => {
      worker.terminate();
      reject(new Error(`Import worker failed: ${event.message}`));
    });
    worker.postMessage(request);
  });
