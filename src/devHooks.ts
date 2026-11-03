// Gives on-TV tests (scripts/tv-probe/) a handle on the app's own code, as
// `window.tiviplayer`, so a probe can run the real import, read back what it
// stored, and add sources without typing them on the remote.

import * as db from "./data/db";
import { importSource } from "./data/importClient";
import { library } from "./library";

export const installDevHooks = () => Object.assign(globalThis, { tiviplayer: { importSource, db, library } });
