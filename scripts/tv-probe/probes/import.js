// Phase 2: imports a source with the app's own importer (src/data/), in its
// Web Worker, and reads part of it back as the guide would. Meanwhile the
// main thread records its frame rate and the TV's free memory.
//
// Input: an ImportRequest (src/data/importer.ts) without "source", such as
//   { "playlistUrl": "http://<dev-ip>:8090/playlist.m3u?channels=2000" }
//   { "kind": "xtream", "server": "http://<dev-ip>:8090", "username": "test", "password": "test" }
// plus:
//   "keep": true   keep the import afterwards (source "tv-probe"); by default
//       it is deleted
//   "fresh": true   delete the app's whole database first. Deleted records
//       keep their disk space until the database compacts, which can fill
//       the storage quota during repeated tests.

async function probe(input) {
  const log = (...args) => console.log("[probe]", ...args);
  const app = window.tiviplayer;
  if (!app) return { error: "window.tiviplayer is missing: deploy a build with src/devHooks.ts" };

  const quota = async () => {
    const { usage, quota: total } = await navigator.storage.estimate();
    return { usageMb: Math.round(usage / 1048576), quotaMb: Math.round(total / 1048576) };
  };
  const { keep, fresh, ...request } = input;
  if (fresh) await app.db.deleteDb();
  const storageBefore = await quota();

  // The TV's free memory, sampled every second.
  const memory = [];
  const sampleMemory = () => memory.push(Math.round(tizen.systeminfo.getAvailableMemory() / 1048576));
  sampleMemory();
  const memoryTimer = setInterval(sampleMemory, 1000);

  // The main thread's frame rate, per second, while the import runs.
  const fps = [];
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

  let lastLog = 0;
  const stages = {};
  const started = performance.now();
  let result;
  try {
    result = await app.importSource({ ...request, source: "tv-probe" }, p => {
      const seconds = Math.round(performance.now() - started) / 1000;
      if (!stages[p.stage]) stages[p.stage] = { startedAt: seconds };
      stages[p.stage].endedAt = seconds;
      if (seconds - lastLog < 5) return;
      lastLog = seconds;
      const mb = Math.round(p.bytes / 1048576);
      log(`${seconds} s: ${p.stage}, ${mb} MB, ${p.channels} channels, ${p.programmes} programmes`);
    });
  } catch (error) {
    result = { error: String(error) };
  }
  running = false;
  clearInterval(memoryTimer);

  // Read back as the app would: all channels, then a guide screen of 10
  // channels over 3 hours from now.
  const reads = {};
  if (result.status === "done") {
    const db = await app.db.openDb();
    let t = performance.now();
    const channels = await app.db.readChannels(db, "tv-probe");
    reads.channels = { count: channels.length, ms: Math.round(performance.now() - t) };
    const withGuide = channels.filter(c => c.guideId).slice(100, 110);
    t = performance.now();
    const now = Date.now();
    const lists = await Promise.all(
      withGuide.map(c => app.db.readGuide(db, "tv-probe", c.guideId, now, now + 3 * 3600000)),
    );
    reads.guideScreen = {
      programmes: lists.reduce((n, list) => n + list.length, 0),
      ms: Math.round(performance.now() - t),
    };
    reads.sample = lists[0]?.[0];
    if (!keep) await app.db.deleteSource(db, "tv-probe");
    db.close();
  }

  return {
    ...result,
    storage: { before: storageBefore, after: await quota() },
    stages,
    reads,
    freeMemoryMb: { before: memory[0], lowest: Math.min(...memory), after: memory.at(-1) },
    mainThreadFps: {
      average: Math.round(fps.reduce((a, b) => a + b, 0) / fps.length),
      lowest: Math.min(...fps),
    },
  };
}
