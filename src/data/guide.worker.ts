// The Web Worker that reads and unpacks guide days (guideReader.ts), so the
// UI thread only receives programmes. Use it through guideClient.ts.

// A worker's postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin

import { openDb } from "./db";
import type { ProgrammeDetails, StoredProgramme } from "./guideCodec";
import { createGuideReader, type DayRequest, type DetailsRequest, type ReadStats } from "./guideReader";

export type GuideWorkerRequest =
  | { type: "read"; id: number; requests: DayRequest[]; dbName?: string }
  | { type: "details"; id: number; request: DetailsRequest; dbName?: string }
  | { type: "clear" };

export type GuideWorkerReply =
  | { type: "read"; id: number; days: StoredProgramme[][]; stats: ReadStats }
  | { type: "details"; id: number; details: ProgrammeDetails }
  | { type: "error"; id: number; message: string };

let reader: ReturnType<typeof createGuideReader> | undefined;

self.addEventListener("message", (event: MessageEvent<GuideWorkerRequest>) => {
  const message = event.data;
  if (message.type === "clear") {
    reader?.clear();
    return;
  }
  // The first request names the database, so tests can use their own.
  reader ??= createGuideReader(() => openDb(message.dbName));
  const { id } = message;
  const reply: Promise<GuideWorkerReply> =
    message.type === "read"
      ? reader.read(message.requests).then(({ days, stats }) => ({ type: "read", id, days, stats }))
      : reader.details(message.request).then(details => ({ type: "details", id, details }));
  reply.then(
    answer => self.postMessage(answer),
    (error: unknown) =>
      self.postMessage({
        type: "error",
        id,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
  );
});
