// Starts an import in its own Web Worker, from the UI thread.

// A worker's postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin

import type { ImportProgress, ImportRequest, ImportResult } from "./importer";
import type { WorkerMessage } from "./import.worker";
// Vite bundles the worker; oxlint can't resolve the "?worker" import.
// oxlint-disable-next-line import/default
import ImportWorker from "./import.worker?worker";

export type { ImportProgress, ImportRequest, ImportResult };

/**
 * Imports a source in a new worker. Aborting `signal` stops the worker; the
 * source's import state then still says "importing" until its next import.
 */
export const importSource = (
  request: ImportRequest,
  onProgress?: (progress: ImportProgress) => void,
  signal?: AbortSignal,
) =>
  new Promise<ImportResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Import cancelled", "AbortError"));
      return;
    }
    const worker = new ImportWorker();
    const stop = () => {
      worker.terminate();
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      stop();
      reject(new DOMException("Import cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", cancel);
    worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.progress);
        return;
      }
      stop();
      if (message.type === "done") resolve(message.result);
      else reject(new Error(message.message));
    });
    worker.addEventListener("error", event => {
      stop();
      reject(new Error(`Import worker failed: ${event.message}`));
    });
    worker.postMessage(request);
  });
