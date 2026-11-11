// Opens a Velio Sync pull in its own Web Worker (sync.worker.ts), from the
// UI thread, so checking it never drops frames (SYNC-PLAN.md, step 2).

// A worker's postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin

import type { DeviceTrust, DeviceView } from "../sync-core/device";
import type { OpenAnswer, OpenRequest } from "./sync.worker";
// Vite bundles the worker; oxlint can't resolve the "?worker" import.
// oxlint-disable-next-line import/default
import SyncWorker from "./sync.worker?worker";

/** How long the last open took inside the worker, and in all (with starting it), in ms; for probes. */
export const lastOpen: { workerMs?: number; totalMs?: number } = {};

/**
 * Resolves with the opened view, or rejects with an Error named as the one
 * the worker threw ("DeviceRemoved", "ReadProblem", "CryptoProblem"…).
 */
export const openInWorker = (trust: DeviceTrust, pull: unknown, previous?: DeviceView) =>
  new Promise<DeviceView>((resolve, reject) => {
    const started = performance.now();
    const worker = new SyncWorker();
    worker.addEventListener("message", (event: MessageEvent<OpenAnswer>) => {
      worker.terminate();
      const answer = event.data;
      if (answer.type === "done") {
        lastOpen.workerMs = Math.round(answer.ms);
        lastOpen.totalMs = Math.round(performance.now() - started);
        resolve(answer.view);
        return;
      }
      const error = new Error(answer.message);
      error.name = answer.name;
      reject(error);
    });
    worker.addEventListener("error", event => {
      worker.terminate();
      reject(new Error(`The sync worker failed: ${event.message}`));
    });
    const request: OpenRequest = { trust, pull, previous };
    worker.postMessage(request);
  });
