// The app's entry: the settings are brought level with their copy in
// IndexedDB (src/data/settingsCopy.ts) before anything reads them, and then
// the app starts (src/index.tsx).

import { settingsCopy } from "./data/settingsCopy";

const start = async () => {
  try {
    const result = await settingsCopy.restore();
    if (result.action === "failed" || result.action === "timedOut") {
      console.error("The settings copy wasn't read:", result);
    }
  } finally {
    await import("./index");
  }
};
void start();
