// The app's sources and their imports (src/data/sourceManager.ts), their
// channels, kept in memory (src/data/lineup.ts), and the guide days read so
// far (src/data/guideCache.ts), read in a worker (src/data/guideClient.ts).

import { createEffect, createRoot } from "solid-js";
import { createGuideCache } from "./data/guideCache";
import { createGuideClient } from "./data/guideClient";
import { importSource } from "./data/importClient";
import { createLineup } from "./data/lineup";
import { createSourceManager } from "./data/sourceManager";

export const library = createSourceManager({ importer: importSource, storage: localStorage });

export const lineup = createLineup({
  sources: library.sources,
  stateOf: id => library.statusOf(id).state,
});

export const guideReader = createGuideClient();
export const guide = createGuideCache({ read: guideReader.read });

// The lineup reloads a source's channels when an import of it finishes,
// which has also replaced its guide.
createRoot(() =>
  createEffect(() => {
    lineup.channels();
    guide.clear();
    guideReader.clear();
  }),
);
