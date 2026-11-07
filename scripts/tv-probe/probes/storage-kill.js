// Phase 8, step 1: whether what the app writes survives the app being
// killed soon after, as run.sh kills it before each probe (and as a TV
// does when it's switched off at the wall, or the app is closed from the
// task list). "write" writes a numbered value to localStorage and to
// IndexedDB, waits "afterMs", and returns, so run.sh kills the app about a
// second later (sooner with KILL_WAIT=0 for the restart); "read" says what
// came back. About 10 s a run.
//
// Input:
//   "write": 7         the number to write
//   "afterMs": 0       how long to wait after writing, before returning
//   "busy": true       keep IndexedDB busy writing (five 2 MB records, over
//                      and over) and localStorage too, until the app is
//                      killed, as an import would
//   (none)             read back what is there

async function probe(input) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const KEY = "tiviplayer.probe.kill";
  const openProbeDb = () =>
    new Promise((resolve, reject) => {
      const r = indexedDB.open("tiviplayer-probe", 2);
      r.addEventListener("upgradeneeded", () => {
        for (const name of ["values", "busy"]) {
          if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
        }
      });
      r.addEventListener("success", () => resolve(r.result));
      r.addEventListener("error", () => reject(r.error));
    });
  const db = await openProbeDb();
  const idb = (mode, run) =>
    new Promise((resolve, reject) => {
      const transaction = db.transaction("values", mode);
      const r = run(transaction.objectStore("values"));
      transaction.addEventListener("complete", () => resolve(r.result));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  // What the app itself keeps, to see whether it went too.
  const appKeys = () =>
    Object.keys(localStorage)
      .filter(key => key.startsWith("tiviplayer.") && key !== KEY)
      .map(key => `${key} ${localStorage.getItem(key).length}`);

  if (input.write !== undefined) {
    const value = JSON.stringify({ n: input.write, at: Date.now() });
    localStorage.setItem(KEY, value);
    await idb("readwrite", store => store.put(value, KEY));
    await sleep(input.afterMs ?? 0);
    if (input.busy) {
      const chunk = new Uint8Array(2_000_000).map((_, i) => i % 251);
      let round = 0;
      const more = () => {
        const transaction = db.transaction("busy", "readwrite", { durability: "relaxed" });
        transaction.objectStore("busy").put(chunk, round % 5);
        localStorage.setItem(`${KEY}.busy`, String(round));
        round++;
        transaction.addEventListener("complete", more);
      };
      more();
      await sleep(200);
    }
    return { wrote: input.write, appKeys: appKeys().length };
  }
  const parse = text => (text ? JSON.parse(text) : undefined);
  const local = parse(localStorage.getItem(KEY));
  const indexed = parse(await idb("readonly", store => store.get(KEY)));
  return {
    localStorage: local?.n ?? null,
    indexedDb: indexed?.n ?? null,
    appKeys: appKeys(),
  };
}
