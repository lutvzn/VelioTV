// Reports where the app is and what it holds: the page, the sources and
// their imports, the channels, the edits and the settings, and the storage
// used. It takes a few
// seconds, waiting up to "waitMs" (default 20000) for channels, and with
// "idle": true for imports to finish too.

async function probe(input) {
  const app = window.tiviplayer;
  const { waitMs = 20_000 } = input;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { idle = false } = input;
  const start = performance.now();
  while (app.lineup.channels().length === 0 && performance.now() - start < waitMs) await sleep(100);
  // With "idle": true, also waits up to waitMs for imports to finish.
  if (idle) while (app.library.importing() && performance.now() - start < waitMs) await sleep(500);
  await sleep(1000);
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  return {
    storageMb: estimate && {
      used: Math.round(estimate.usage / 1e5) / 10,
      quota: Math.round(estimate.quota / 1e5) / 10,
    },
    hash: location.hash,
    storageKeys: Object.keys(localStorage),
    pages: ["live", "guidePage", "settingsPage", "pinPrompt", "channelOptions"].filter(name => app[name]),
    sources: app.library.sources().map(source => ({
      id: source.id,
      name: source.name,
      disabled: !!source.disabled,
      state: app.library.statusOf(source.id).state?.status ?? "none",
      started: app.library.statusOf(source.id).state?.startedAt,
      lastDone: app.library.statusOf(source.id).state?.lastDoneAt,
      importing: app.library.statusOf(source.id).importing,
    })),
    channels: app.lineup.channels().length,
    shown: app.liveView?.().channels.length,
    edits: app.edits.all(),
    settings: app.settings?.all(),
    unlocked: app.settings?.unlocked(),
    lastChannel: localStorage.getItem("tiviplayer.lastChannel"),
    playing: app.live?.zapper.playing()?.name,
    player: app.player.status().state,
  };
}
