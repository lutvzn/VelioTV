// The app's sources and their imports (src/data/sourceManager.ts), their
// channels, kept in memory (src/data/lineup.ts), and the guide days read so
// far (src/data/guideCache.ts).

import { createEffect, createRoot } from "solid-js";
import { openDb, readGuide } from "./data/db";
import { createGuideCache } from "./data/guideCache";
import { importSource } from "./data/importClient";
import { createLineup } from "./data/lineup";
import { createSourceManager } from "./data/sourceManager";

export const library = createSourceManager({ importer: importSource, storage: localStorage });

export const lineup = createLineup({
  sources: library.sources,
  stateOf: id => library.statusOf(id).state,
});

let db: Promise<IDBDatabase> | undefined;
export const guide = createGuideCache({
  read: async (source, guideId, from, to) => readGuide(await (db ??= openDb()), source, guideId, from, to),
});

// The lineup reloads a source's channels when an import of it finishes,
// which has also replaced its guide.
createRoot(() =>
  createEffect(() => {
    lineup.channels();
    guide.clear();
  }),
);
