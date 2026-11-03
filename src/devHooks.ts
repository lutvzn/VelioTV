// Gives on-TV tests (scripts/tv-probe/) a handle on the app's own code, as
// `window.tiviplayer`, so a probe can run the real import and read back what
// it stored.

import * as db from "./data/db";
import { importSource } from "./data/importClient";

export const installDevHooks = () => Object.assign(globalThis, { tiviplayer: { importSource, db } });
