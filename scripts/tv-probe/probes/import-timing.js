// Where an import's time goes on the TV: imports a source with the app's
// own importer, in its worker, with `timing` on (ImportTiming in
// src/data/importer.ts), and reports the guide stage split into waiting for
// the download, decoding text, parsing the XMLTV, packing blocks (JSON and
// deflate) and waiting for IndexedDB, each with its share of the stage and
// the programmes it got through a second. The channel stage is split too:
// waiting for the playlist, parsing it, telling films and episodes from
// channels, keys, and storing. Then it times reading the films and series,
// and the channels, back on the page, and deletes the import.
//
// Before the import, it downloads each guide file once by itself, reading
// the bytes and dropping them, to show how long the network alone takes.
//
// Input: an ImportRequest (src/data/importer.ts) without "source", such as
//   { "playlistUrl": "http://<dev-ip>:8090/playlist.m3u?channels=2000" }
// Optional: "downloadFirst": false to skip the download on its own. For the
// channel stage alone, give "guideUrls": [], as with
//   { "playlistUrl": "http://<dev-ip>:8090/playlist.m3u?channels=20000&vod=1&films=60000&series=5000",
//     "guideUrls": [] }
//
// About 30 s for 1,000 test channels, 1 minute for 2,000; the 10,000-channel
// source takes about 3 minutes.

async function probe(input) {
  const log = (...args) => console.log("[probe]", ...args);
  const app = window.velio;
  if (!app?.importSource) return { error: "window.velio is missing: deploy a build with src/devHooks.ts" };
  const { downloadFirst = true, ...request } = input;

  // The guide addresses, from the playlist's url-tvg, unless given.
  let guideUrls = request.guideUrls;
  if (!guideUrls && request.playlistUrl) {
    const head = (await (await fetch(request.playlistUrl)).text()).slice(0, 4096);
    const named = head.match(/url-tvg="([^"]+)"/);
    guideUrls = named ? named[1].split(",").map(url => url.trim()) : [];
  }
  const downloads = [];
  if (downloadFirst) {
    for (const url of guideUrls ?? []) {
      const started = performance.now();
      const reader = (await fetch(url)).body.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
      const ms = Math.round(performance.now() - started);
      downloads.push({ url, mb: Math.round(bytes / 10485.76) / 100, ms });
      log(`downloaded ${url} alone: ${bytes} bytes in ${ms} ms`);
    }
  }

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
  const started = performance.now();
  let result;
  try {
    result = await app.importSource({ ...request, source: "tv-probe", timing: true }, p => {
      const seconds = Math.round(performance.now() - started) / 1000;
      if (seconds - lastLog < 5) return;
      lastLog = seconds;
      log(`${seconds} s: ${p.stage}, ${p.channels} channels, ${p.programmes} programmes`);
    });
  } catch (error) {
    result = { error: String(error) };
  }
  running = false;

  // Reading the films, series and channels back, as the app does at start.
  const db = await app.db.openDb();
  const readBack = {};
  if (!result.error) {
    let from = performance.now();
    await app.db.readVod(db, "tv-probe");
    readBack.vodMs = Math.round(performance.now() - from);
    from = performance.now();
    await app.db.readChannels(db, "tv-probe");
    readBack.channelsMs = Math.round(performance.now() - from);
  }
  await app.db.deleteSource(db, "tv-probe");
  db.close();
  if (!result.timing) return { error: result.error ?? "no timing: deploy a newer build", downloads };

  const t = {};
  for (const [name, ms] of Object.entries(result.timing))
    if (typeof ms === "number") t[name] = Math.round(ms);
  const channelParts = {};
  for (const [name, ms] of Object.entries(result.timing.channels ?? {})) {
    channelParts[name] = { ms: Math.round(ms), share: `${Math.round((ms / t.channelsMs) * 100)}%` };
  }
  const read = result.programmesRead;
  const share = ms => `${Math.round((ms / t.guideMs) * 100)}%`;
  const rate = ms => (ms > 0 ? Math.round(read / (ms / 1000)) : undefined);
  const parts = {};
  if (t.guideMs > 0) {
    for (const name of ["downloadWaitMs", "decodeMs", "parseMs", "packMs", "storageWaitMs", "otherMs"]) {
      parts[name] = { ms: t[name], share: share(t[name]), programmesPerSecond: rate(t[name]) };
    }
  }
  return {
    seconds: result.seconds,
    channels: result.channels,
    programmesRead: read,
    programmesStored: result.programmes,
    guideMb: Math.round(result.guideBytes / 10485.76) / 100,
    downloadsAlone: downloads,
    films: result.films,
    series: result.series,
    channelsMs: t.channelsMs,
    channelParts,
    guideMs: t.guideMs,
    guide: parts,
    mergeMs: t.mergeMs,
    readBack,
    mainThreadFps: {
      average: Math.round(fps.reduce((a, b) => a + b, 0) / fps.length),
      lowest: Math.min(...fps),
    },
  };
}
