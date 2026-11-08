// The old browser's smoke test, for scripts/old-chrome/run.mjs: imports a
// test playlist and its guide (the import worker, and fflate's gunzip where
// the browser has no DecompressionStream), then reads a channel's day and the
// details of the programme on now (the guide worker). Last it switches the
// app to Portuguese and back, which loads that language's text (import()).
//
// Input, optional:
//   "url": "http://127.0.0.1:8090/playlist.m3u?channels=60"   the playlist

async function probe(input) {
  const app = window.velio;
  const library = app.library;
  const started = performance.now();
  const source = library.add({
    name: "Old browser",
    kind: "m3u",
    url: input.url || "http://127.0.0.1:8090/playlist.m3u?channels=60",
    refreshHours: 24,
  });
  await library.whenIdle();
  const importMs = Math.round(performance.now() - started);
  const state = library.statusOf(source.id).state || {};
  if (state.status !== "done") return { error: state.error || "The import didn't finish", state };

  const mine = () => app.lineup.channels().filter(c => c.source === source.id);
  for (let waited = 0; waited < 10000 && mine().length === 0; waited += 200) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const channel = mine().find(c => c.guideId);
  if (!channel) return { error: "No channel with a guide in the lineup", lineup: mine().length };
  const client = app.createGuideClient();
  const now = Date.now();
  const programmes = await client.read(source.id, channel.guideId, Math.floor(now / app.db.DAY));
  const onNow = programmes.find(p => p.start <= now && p.stop > now);
  const details = onNow ? await client.details(source.id, channel.guideId, onNow.start) : {};
  client.close();
  const result = {
    browser: navigator.userAgent,
    decompressionStream: typeof DecompressionStream !== "undefined",
    importMs,
    channels: state.channels,
    programmes: state.programmes,
    lineup: mine().length,
    guide: { channel: channel.name, programmes: programmes.length, onNow: onNow && onNow.title },
    description: Boolean(details.description),
  };
  if (!onNow || !details.description) result.error = "No programme on now, or it had no description";

  const before = app.settings.language();
  app.settings.setLanguage("pt-BR");
  for (let waited = 0; waited < 5000 && app.language() !== "pt-BR"; waited += 100) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  result.portuguese = app.text("menu.settings");
  app.settings.setLanguage(before);
  if (result.portuguese !== "Configurações") result.error = "The Portuguese text didn't load";
  return result;
}
