// Phase 8, step 2: whether the TV gives back the space of deleted IndexedDB
// data. It reports navigator.storage.estimate() as it goes:
//   "fill": writes "mb" of test records to a store, deletes them, and then
//           writes as much to a database of its own and deletes the whole
//           database; then it waits "waitSeconds" and looks again.
//   (none): just the usage now (after a restart, say).
// About 20 s plus the wait.
//
// Input:
//   "mode": "fill"
//   "mb": 20
//   "waitSeconds": 60

async function probe(input) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const usage = async () => {
    const estimate = await navigator.storage.estimate();
    return Math.round(estimate.usage / 1e5) / 10;
  };
  const quota = Math.round((await navigator.storage.estimate()).quota / 1e5) / 10;
  if (input.mode !== "fill") return { usageMb: await usage(), quotaMb: quota };

  const open = (name, version, upgrade) =>
    new Promise((resolve, reject) => {
      const r = indexedDB.open(name, version);
      r.addEventListener("upgradeneeded", () => upgrade(r.result));
      r.addEventListener("success", () => resolve(r.result));
      r.addEventListener("error", () => reject(r.error));
    });
  const completed = transaction =>
    new Promise((resolve, reject) => {
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
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
  const fill = async (db, store) => {
    for (let i = 0; i < (input.mb ?? 20); i++) {
      const transaction = db.transaction(store, "readwrite");
      transaction.objectStore(store).put(record(i), i);
      await completed(transaction);
    }
  };
  const steps = [];
  const note = async label => {
    const row = { step: label, usageMb: await usage() };
    steps.push(row);
    log(label, row);
  };

  await note("start");
  // 1. Records deleted from a store, as a source's refresh or removal does.
  const db = await open("tiviplayer-probe-space", 1, created => created.createObjectStore("junk"));
  await fill(db, "junk");
  await note("records written");
  const clearing = db.transaction("junk", "readwrite");
  clearing.objectStore("junk").clear();
  await completed(clearing);
  await note("records deleted");
  db.close();
  // 2. A whole database deleted.
  const whole = await open("tiviplayer-probe-whole", 1, created => created.createObjectStore("junk"));
  await fill(whole, "junk");
  await note("database written");
  whole.close();
  await new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase("tiviplayer-probe-whole");
    r.addEventListener("success", resolve);
    r.addEventListener("error", () => reject(r.error));
  });
  await note("database deleted");
  await sleep((input.waitSeconds ?? 60) * 1000);
  await note(`${input.waitSeconds ?? 60} s later`);
  return { quotaMb: quota, steps };
}
