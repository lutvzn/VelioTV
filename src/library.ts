// The app's sources and their imports; see src/data/sourceManager.ts.

import { importSource } from "./data/importClient";
import { createSourceManager } from "./data/sourceManager";

export const library = createSourceManager({ importer: importSource, storage: localStorage });
