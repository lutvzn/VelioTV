// A debrid service on the TV (PLAN.md, "Debrid services"): plays a free
// film's torrents through the profile's service, as the app does
// (src/play/addonPlay.ts, streamOf), with Torrentio's plain list (no key).
//
// 1. Chooses `profile` and sets `service`'s `key` for it, unless the key is
//    left out and the profile has one already.
// 2. Asks Torrentio for the film's torrents.
// 3. Asks the service which it has (for those that can say), timed.
// 4. Plays the first `plays` of those it has (or of all, for those that can't
//    say): the time to the link and to the first picture, and whether the
//    clock moves; then resolves the first again, to see it's kept.
// 5. Puts the profile's debrid record back as it was, unless `keep`.
//
// Under a minute. The result never has the key or the links, which carry
// it or a token: only their host.
//
// Input:
//   "key": "…"             the service's API key (pass it from .env; never print it)
//   "service": "torbox"    src/debrid/services.ts
//   "profile": "Living room"
//   "film": "tt1727587"    Sintel; tt1254207 is Big Buck Bunny
//   "plays": 1
//   "holdMs": 4000
//   "keep": false

async function probe(input) {
  const app = window.velio;
  const { profiles, player, debrid, debridAccounts } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (test, ms = 15_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(50);
    }
    return Math.round(performance.now() - start);
  };
  const hostOf = url => {
    try {
      return new URL(url).host;
    } catch {
      return "?";
    }
  };
  const service = input.service || "torbox";
  const result = { service };

  // 1.
  const wanted = profiles.list().find(one => one.name === (input.profile || "Living room"));
  if (!wanted) return { error: "No such profile", profiles: profiles.list().map(one => one.name) };
  if (profiles.currentId() !== wanted.id) profiles.choose(wanted.id);
  const before = JSON.parse(JSON.stringify(debridAccounts.accounts()));
  if (input.key) debridAccounts.setKey(service, input.key);
  if (!debridAccounts.accounts().keys[service]) return { ...result, error: "No key for the service" };
  debridAccounts.use(service);
  debrid.forget();

  try {
    // 2.
    const film = input.film || "tt1727587";
    const askStart = performance.now();
    const answer = await (await fetch(`https://torrentio.strem.fun/stream/movie/${film}.json`)).json();
    result.torrentioMs = Math.round(performance.now() - askStart);
    const torrents = (answer.streams || [])
      .filter(stream => /^[0-9a-f]{40}$/i.test(stream.infoHash || ""))
      .map(stream => ({
        title: (stream.title || "").split("\n")[0],
        filename: stream.behaviorHints && stream.behaviorHints.filename,
        torrent: {
          infoHash: stream.infoHash.toLowerCase(),
          ...(typeof stream.fileIdx === "number" ? { fileIdx: stream.fileIdx } : {}),
          sources: stream.sources || [],
        },
      }));
    result.torrents = torrents.length;
    if (torrents.length === 0) return { ...result, error: "Torrentio listed no torrents" };

    // 3.
    const checkStart = performance.now();
    await debrid.check(torrents.map(one => one.torrent.infoHash));
    result.checkMs = Math.round(performance.now() - checkStart);
    const states = {};
    torrents.forEach(one => {
      const state = debrid.stateOf(one.torrent.infoHash);
      states[state] = (states[state] || 0) + 1;
    });
    result.states = states;

    // 4.
    const playable = torrents.filter(one => debrid.stateOf(one.torrent.infoHash) !== "notCached");
    const plays = [];
    for (const one of playable.slice(0, input.plays || 1)) {
      const tried = { title: one.title, state: debrid.stateOf(one.torrent.infoHash) };
      const start = performance.now();
      let resolvedMs;
      const wantedFile = { torrent: one.torrent, ...(one.filename ? { filename: one.filename } : {}) };
      void player.play({
        url: `magnet:?xt=urn:btih:${one.torrent.infoHash}`,
        startTimeoutMs: 45_000,
        from: service,
        resolve: () =>
          debrid.resolve(wantedFile).then(resolved => {
            resolvedMs = Math.round(performance.now() - start);
            tried.host = hostOf(resolved.url);
            tried.file = resolved.filename;
            tried.sizeMB = resolved.sizeBytes ? Math.round(resolved.sizeBytes / 1e6) : undefined;
            return resolved.url;
          }),
      });
      await waitFor(() => ["playing", "failed"].includes(player.status().state), 60_000);
      const status = player.status();
      tried.resolvedMs = resolvedMs;
      tried.playState = status.state;
      if (status.state === "playing") {
        tried.firstPictureMs = Math.round(performance.now() - start);
        const at = player.position();
        await sleep(input.holdMs || 4000);
        tried.movedMs = player.position() - at;
        tried.durationS = Math.round(player.duration() / 1000);
        tried.formats = player.formats();
      } else {
        tried.error = status.error || `still ${status.state} after 60 s`;
      }
      player.stop();
      tried.after = debrid.stateOf(one.torrent.infoHash);
      plays.push(tried);
      await sleep(500);
    }
    result.plays = plays;
    if (playable.length > 0) {
      const again = performance.now();
      await debrid.resolve({
        torrent: playable[0].torrent,
        ...(playable[0].filename ? { filename: playable[0].filename } : {}),
      });
      result.keptLinkMs = Math.round(performance.now() - again);
    }
  } catch (error) {
    result.error = String((error && error.message) || error);
  } finally {
    // 5.
    if (!input.keep) {
      const after = debridAccounts.accounts();
      for (const id of Object.keys(after.keys)) if (!before.keys[id]) debridAccounts.setKey(id, "");
      for (const id of Object.keys(before.keys)) debridAccounts.setKey(id, before.keys[id]);
      debridAccounts.use(before.service);
      debrid.forget();
    }
    result.serviceAfter = debridAccounts.accounts().service || "none";
  }
  return result;
}
