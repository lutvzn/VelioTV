// Checks and opens a Velio Sync pull off the UI's thread (SYNC-PLAN.md,
// step 2): the owner's Ed25519 signature, the boxed profile keys, and the
// lists that changed. It keeps nothing: each request brings the trust, the
// pull and the last view. Start it through syncOpen.ts.

// A worker's postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin

import { openPull, type DeviceTrust, type DeviceView } from "../sync-core/device";

export interface OpenRequest {
  trust: DeviceTrust;
  pull: unknown;
  previous?: DeviceView;
}

export type OpenAnswer =
  | { type: "done"; view: DeviceView; ms: number }
  | { type: "error"; name: string; message: string };

self.addEventListener("message", (event: MessageEvent<OpenRequest>) => {
  const { trust, pull, previous } = event.data;
  const started = performance.now();
  let answer: OpenAnswer;
  try {
    answer = { type: "done", view: openPull(trust, pull, previous), ms: performance.now() - started };
  } catch (error) {
    answer =
      error instanceof Error
        ? { type: "error", name: error.name, message: error.message }
        : { type: "error", name: "Error", message: String(error) };
  }
  self.postMessage(answer);
});
