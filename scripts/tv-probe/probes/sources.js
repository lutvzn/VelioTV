// Phase 2: adds sources through the app's source manager (src/data/
// sourceManager.ts), as Settings would, so they can be checked on screen
// without typing them on the remote. It can wait for their imports, and
// records the frame rate meanwhile.
//
// Input, all optional:
//   "clear": true   remove every source first, with its data
//   "add": [SourceDraft, ...]   sources to add (src/data/sources.ts), such as
//       { "name": "Test M3U", "kind": "m3u", "url": "http://<dev-ip>:8090/playlist.m3u?channels=300", "refreshHours": 24 }
//       { "name": "Test Xtream", "kind": "xtream", "server": "http://<dev-ip>:8090", "username": "small", "password": "small", "refreshHours": 24 }
//   "wait": true   wait for all imports to finish (at most "timeoutSeconds", 120 by default)
//   "open": true   open Settings afterwards
//
// The result lists the sources and how their last imports went.

async function probe(input) {
  const app = window.velio;
  if (!app?.library) return { error: "window.velio.library is missing: deploy a newer build" };
  const { library } = app;

  if (input.clear) {
    for (const source of library.sources()) await library.remove(source.id);
  }
  for (const draft of input.add ?? []) library.add(draft);

  const fps = [];
  let waited;
  if (input.wait) {
    let frames = 0;
    let since = performance.now();
    let running = true;
    requestAnimationFrame(function count(now) {
      frames++;
      if (now - since >= 1000) {
        fps.push(Math.round((frames * 1000) / (now - since)));
        frames = 0;
        since = now;
      }
      if (running) requestAnimationFrame(count);
    });
    const started = performance.now();
    const timeout = (input.timeoutSeconds ?? 120) * 1000;
    const finished = await Promise.race([
      library.whenIdle().then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), timeout)),
    ]);
    running = false;
    waited = { finished, seconds: Math.round(performance.now() - started) / 1000 };
  }

  if (input.open) location.hash = "#/settings";

  return {
    waited,
    fps: fps.length ? { min: Math.min(...fps.slice(1)), samples: fps } : undefined,
    sources: library.sources().map(source => {
      const { state, importing, queued, progress } = library.statusOf(source.id);
      return { id: source.id, name: source.name, kind: source.kind, importing, queued, progress, state };
    }),
  };
}
