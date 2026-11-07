// Reads guide days through the guide worker (guide.worker.ts), from the UI
// thread. Days asked for in the same task go to the worker together, so a
// guide screen is one message and one transaction.

// A worker's postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin

import type { StoredProgramme } from "./guideCodec";
import type { DayRequest } from "./guideReader";
import type { GuideWorkerReply, GuideWorkerRequest } from "./guide.worker";
// Vite bundles the worker; oxlint can't resolve the "?worker" import.
// oxlint-disable-next-line import/default
import GuideWorker from "./guide.worker?worker";

interface Waiting {
  resolve: (programmes: StoredProgramme[]) => void;
  reject: (error: Error) => void;
}

export const createGuideClient = (options: { dbName?: string } = {}) => {
  let worker: Worker | undefined;
  let nextId = 0;
  const sent = new Map<number, Waiting[]>();
  let queued: { request: DayRequest; waiting: Waiting }[] = [];
  /** Totals since the client started, for probes. */
  const stats = { messages: 0, days: 0, getMs: 0, decodeMs: 0, decoded: 0 };

  const failAll = (error: Error) => {
    for (const waiting of sent.values()) for (const w of waiting) w.reject(error);
    sent.clear();
  };

  const start = () => {
    const created = new GuideWorker();
    created.addEventListener("message", (event: MessageEvent<GuideWorkerReply>) => {
      const reply = event.data;
      const waiting = sent.get(reply.id);
      sent.delete(reply.id);
      if (!waiting) return;
      if (reply.type === "error") {
        for (const w of waiting) w.reject(new Error(reply.message));
        return;
      }
      stats.messages++;
      stats.days += reply.days.length;
      stats.getMs += reply.stats.getMs;
      stats.decodeMs += reply.stats.decodeMs;
      stats.decoded += reply.stats.decoded;
      waiting.forEach((w, i) => w.resolve(reply.days[i]));
    });
    created.addEventListener("error", event => {
      // Start a new worker for the next read.
      created.terminate();
      if (worker === created) worker = undefined;
      failAll(new Error(`Guide worker failed: ${event.message}`));
    });
    return created;
  };

  const post = (message: GuideWorkerRequest) => (worker ??= start()).postMessage(message);

  const flush = () => {
    const batch = queued;
    queued = [];
    if (batch.length === 0) return;
    const id = nextId++;
    sent.set(
      id,
      batch.map(b => b.waiting),
    );
    post({ type: "read", id, requests: batch.map(b => b.request), dbName: options.dbName });
  };

  return {
    /** A guide channel's programmes that overlap a UTC day, in start order. */
    read: (source: string, channel: string, day: number) =>
      new Promise<StoredProgramme[]>((resolve, reject) => {
        if (queued.length === 0) queueMicrotask(flush);
        queued.push({ request: { source, channel, day }, waiting: { resolve, reject } });
      }),
    /** Makes the worker forget what it unpacked, such as after an import replaced the guide. */
    clear: () => {
      if (worker) post({ type: "clear" });
    },
    stats,
    /** Stops the worker; reads waiting for it fail. */
    close: () => {
      worker?.terminate();
      worker = undefined;
      failAll(new Error("Guide client closed"));
    },
  };
};

export type GuideClient = ReturnType<typeof createGuideClient>;
