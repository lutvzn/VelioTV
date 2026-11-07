// The app's entry: the settings are brought level with their copy in
// IndexedDB (src/data/settingsCopy.ts) before anything reads them, and the
// database is opened once, upgrading or making it again if it must
// (src/data/db.ts); then the app starts (src/index.tsx).

import { prepareDb } from "./data/db";
import { settingsCopy } from "./data/settingsCopy";

/** How long the start waits for the database before going on. */
const PREPARE_TIMEOUT_MS = 15_000;

const start = async () => {
  const database = Promise.race([
    prepareDb().catch((error: unknown) => console.error("Couldn't prepare the database:", error)),
    new Promise(resolve => setTimeout(resolve, PREPARE_TIMEOUT_MS)),
  ]);
  try {
    const result = await settingsCopy.restore();
    if (result.action === "failed" || result.action === "timedOut") {
      console.error("The settings copy wasn't read:", result);
    }
    await database;
  } finally {
    await import("./index");
  }
};
void start();
