// Phase 8, step 1: the settings' copy in IndexedDB (src/data/settingsCopy.ts)
// puts them back when localStorage reads as empty or old at a start. Each
// run is about 10 s; run.sh restarts the app between runs.
//
// 1. "wipe": saves every "tiviplayer." key to the probe's own database, then
//    removes them from localStorage behind the app's back, as if it had read
//    as empty. The next start should put them back.
// 2. "old": the same, but leaves localStorage as it was some writes ago:
//    an older stamp and an empty Favourites.
// 3. No "mode": says what the start did (settingsCopy.lastRestore()) and
//    whether every key is as saved. If not, it puts the saved keys back
//    itself, so the TV keeps its sources either way.
//
// Input:
//   "mode": "wipe" | "old"   (none) checks after the restart

async function probe(input) {
  const app = window.tiviplayer;
  if (!app?.settingsCopy) return { error: "window.tiviplayer.settingsCopy is missing: deploy the app first" };
  const { settingsCopy } = app;
  const PREFIX = "tiviplayer.";
  const ours = key => key.startsWith(PREFIX) && !key.startsWith("tiviplayer.probe.");
  const keys = () => Object.keys(localStorage).filter(ours);
  const snapshot = () => Object.fromEntries(keys().map(key => [key, localStorage.getItem(key)]));

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
  const sources = () =>
    JSON.parse(localStorage.getItem("tiviplayer.sources") ?? "null")?.sources?.length ?? 0;

  if (input.mode === "wipe" || input.mode === "old") {
    await settingsCopy.flushed();
    const saved = snapshot();
    await idb("readwrite", store => store.put(saved, "settingsBackup"));
    const before = { keys: Object.keys(saved).length, sources: sources(), start: settingsCopy.lastRestore() };
    if (input.mode === "wipe") {
      for (const key of keys()) localStorage.removeItem(key);
    } else {
      // Older: an earlier stamp, and Favourites as before any were added.
      const edits = JSON.parse(saved["tiviplayer.channelEdits"] ?? "{}");
      localStorage.setItem("tiviplayer.channelEdits", JSON.stringify({ ...edits, favourites: [] }));
      localStorage.setItem("tiviplayer.savedAt", String(Number(saved["tiviplayer.savedAt"]) - 60_000));
    }
    return { mode: input.mode, before, left: keys().length };
  }

  const saved = await idb("readonly", store => store.get("settingsBackup"));
  if (!saved) return { start: settingsCopy.lastRestore(), error: "Nothing saved: run with a mode first" };
  const now = snapshot();
  const differ = Object.keys(saved).filter(key => key !== "tiviplayer.savedAt" && now[key] !== saved[key]);
  const result = {
    start: settingsCopy.lastRestore(),
    keys: keys().length,
    savedKeys: Object.keys(saved).length,
    differ,
    sources: sources(),
    channels: app.lineup.channels().length,
  };
  if (differ.length > 0) {
    for (const [key, value] of Object.entries(saved)) app.settingsCopy.storage.setItem(key, value);
    await settingsCopy.flushed();
    result.putBackByProbe = true;
  }
  return result;
}
