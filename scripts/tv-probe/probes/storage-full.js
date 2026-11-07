// Phase 8, step 3: an import that runs out of space. Fills storage with a
// database of junk until only "freeMb" is left, then imports a source again
// and reports how it ended: its import state, its channel list and guide as
// stored, and the usage as it went. Then it deletes the junk.
// About 3 minutes for the 10,000-channel test source; "cleanup" only deletes
// the junk (if a run was cut short).
//
// Input:
//   "source": "Test 10k"   the source's name
//   "freeMb": 8            space left before the import
//   "cleanup": true        only delete the junk

async function probe(input) {
  const app = window.tiviplayer;
  const { library, db: data } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const JUNK = "tiviplayer-probe-junk";
  const mb = bytes => Math.round(bytes / 1e5) / 10;
  const estimate = async () => {
    const { usage, quota } = await navigator.storage.estimate();
    return { usageMb: mb(usage), quotaMb: mb(quota) };
  };
  const deleteJunk = () =>
    new Promise(resolve => {
      const r = indexedDB.deleteDatabase(JUNK);
      for (const event of ["success", "error", "blocked"]) r.addEventListener(event, resolve);
    });
  if (input.cleanup) {
    await deleteJunk();
    return { cleaned: true, ...(await estimate()) };
  }

  const source = library.sources().find(one => one.name === (input.source ?? "Test 10k"));
  if (!source) return { error: "No such source", sources: library.sources().map(one => one.name) };
  await library.whenIdle();
  const stored = async () => {
    const db = await data.openDb();
    const state = await data.readImport(db, source.id);
    const channels = await data.readChannels(db, source.id);
    const guideRecords = await new Promise((resolve, reject) => {
      if (state?.guide === undefined) return resolve(0);
      const r = db.transaction("guide").objectStore("guide").count(data.sourceRange(state.guide));
      r.addEventListener("success", () => resolve(r.result));
      r.addEventListener("error", () => reject(r.error));
    });
    db.close();
    const {
      status,
      error,
      channels: count,
      programmes,
      guideBytes,
      guideTrimmed,
      guideLastDay,
    } = state ?? {};
    return {
      status,
      error,
      count,
      programmes,
      guideMb: guideBytes && mb(guideBytes),
      guideTrimmed,
      guideLastDay,
      listed: channels.length,
      guideRecords,
    };
  };
  const before = { ...(await stored()), ...(await estimate()) };
  log("before", before);

  // Different bytes in each record, so nothing compresses them away.
  const record = seed => {
    const bytes = new Uint8Array(1_000_000);
    let x = seed * 2654435761;
    for (let i = 0; i < bytes.length; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      bytes[i] = x >>> 24;
    }
    return bytes;
  };
  const junk = await new Promise((resolve, reject) => {
    const r = indexedDB.open(JUNK, 1);
    r.addEventListener("upgradeneeded", () => r.result.createObjectStore("junk"));
    r.addEventListener("success", () => resolve(r.result));
    r.addEventListener("error", () => reject(r.error));
  });
  const freeMb = input.freeMb ?? 8;
  let junkMb = 0;
  for (;;) {
    const { usageMb, quotaMb } = await estimate();
    if (quotaMb - usageMb <= freeMb) break;
    try {
      await new Promise((resolve, reject) => {
        const transaction = junk.transaction("junk", "readwrite");
        transaction.objectStore("junk").put(record(junkMb), junkMb);
        transaction.addEventListener("complete", resolve);
        transaction.addEventListener("error", () => reject(transaction.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
      });
      junkMb++;
    } catch (caught) {
      log("filling stopped", String(caught));
      break;
    }
  }
  junk.close();
  const full = { junkMb, ...(await estimate()) };
  log("filled", full);

  library.refresh(source.id);
  const samples = [];
  const started = performance.now();
  const idle = library.whenIdle().then(() => true);
  let finished = false;
  while (!finished && performance.now() - started < 240_000) {
    finished = await Promise.race([idle, sleep(5000).then(() => false)]);
    const progress = library.importing()?.progress;
    const row = {
      s: Math.round((performance.now() - started) / 1000),
      ...(await estimate()),
      stage: progress?.stage,
      programmes: progress?.programmes,
    };
    samples.push([row.s, row.usageMb, row.stage, row.programmes]);
    log("importing", row);
  }
  const after = { seconds: Math.round((performance.now() - started) / 1000), finished, ...(await stored()) };
  log("after", after);

  await deleteJunk();
  await sleep(2000);
  const cleaned = { ...(await estimate()), lineup: app.lineup.channels().length };
  return { before, full, after, cleaned, samples };
}
