// How much IndexedDB will store before QuotaExceededError. Writes 1 MB
// blocks of random bytes (which storage can't compress) to a test database
// until a write fails, then deletes the database.
//
// Input (all optional):
//   "maxMb": 2000   stop here even if nothing has failed
//
// Deleted data keeps its disk space for a while, so run this on a freshly
// installed app for a clean result.

async function probe(input) {
  const NAME = "tv-probe-quota";
  const MB = 1048576;
  const maxMb = input.maxMb ?? 2000;
  const log = (...args) => console.log("[probe]", ...args);
  const request = r =>
    new Promise((resolve, reject) => {
      r.addEventListener("success", () => resolve(r.result));
      r.addEventListener("error", () => reject(r.error));
    });
  const open = indexedDB.open(NAME, 1);
  open.addEventListener("upgradeneeded", () => open.result.createObjectStore("blocks"));
  const db = await request(open);

  const block = () => {
    const bytes = new Uint8Array(MB);
    for (let i = 0; i < MB; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
    return bytes.buffer;
  };
  const estimate = async () => {
    const { usage, quota } = await navigator.storage.estimate();
    return { usageMb: Math.round(usage / MB), quotaMb: Math.round(quota / MB) };
  };
  const freeDiskMb = () =>
    new Promise(resolve =>
      tizen.systeminfo.getPropertyValue(
        "STORAGE",
        s => resolve(Math.round(s.units[0].availableCapacity / MB)),
        () => resolve(null),
      ),
    );

  const before = { ...(await estimate()), freeDiskMb: await freeDiskMb() };
  let written = 0;
  let error = null;
  const started = performance.now();
  while (written < maxMb) {
    try {
      const transaction = db.transaction("blocks", "readwrite");
      // Ten blocks per transaction.
      for (let i = 0; i < 10; i++) transaction.objectStore("blocks").put(block(), written + i);
      await new Promise((resolve, reject) => {
        transaction.addEventListener("complete", resolve);
        transaction.addEventListener("error", () => reject(transaction.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
      });
      written += 10;
      if (written % 100 === 0) log(`${written} MB written`);
    } catch (e) {
      error = `${e?.name}: ${e?.message}`;
      break;
    }
  }
  const after = { ...(await estimate()), freeDiskMb: await freeDiskMb() };
  db.close();
  await request(indexedDB.deleteDatabase(NAME)).catch(() => {});
  return {
    writtenMb: written,
    error,
    seconds: Math.round(performance.now() - started) / 1000,
    before,
    after,
  };
}
