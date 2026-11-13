// Debrid add-ons on the TV (PLAN.md, "Debrid add-ons"), with the test
// server's made-up one (scripts/test-streams/debrid.mjs) added to the
// profile: /sync/add-list?kind=stremio&path=/debrid/key=velio-test/manifest.json&profiles=…
//
// 1. Chooses `profile`, and waits for the add-on's manifest, whose settings
//    are in its path.
// 2. Asks the add-ons for the first test film's streams.
// 3. Plays each debrid stream with the app's player: the time to the first
//    picture through the resolve's redirects (or the error), the formats
//    and tracks AVPlay found, whether the clock moves, and a seek to 0:40;
//    the server's log says whether the player asked the resolve again.
//
// About 2.5 minutes for all 14 streams. Listen while it runs: each plays
// `holdMs`, then 2 s after the seek.
//
// Input, all optional:
//   "profile": "Living room"
//   "only": ["hevc10-dts", "5 s"]   streams whose name has one of these
//   "holdMs": 3000

async function probe(input) {
  const app = window.velio;
  const { addons, profiles, player } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (test, ms = 15_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(50);
    }
    return Math.round(performance.now() - start);
  };
  const result = {};

  // 1.
  const wanted = profiles.list().find(one => one.name === (input.profile || "Living room"));
  if (!wanted) return { error: "No such profile", profiles: profiles.list().map(one => one.name) };
  if (profiles.currentId() !== wanted.id) profiles.choose(wanted.id);
  const debrid = () => addons.states().find(state => state.list.url.includes("/debrid/"));
  result.manifestMs = await waitFor(() => debrid()?.manifest || debrid()?.problem, 20_000);
  const state = debrid();
  if (!state?.manifest) {
    return {
      ...result,
      error: "No debrid add-on",
      problem: state?.problem,
      addons: addons.states().map(one => one.list.url),
    };
  }
  result.addon = { name: state.manifest.name, url: state.list.url };
  const server = new URL(state.list.url).origin;
  const readLog = async () => (await fetch(`${server}/debrid/log?clear=1`)).json();

  // 2.
  const askStart = performance.now();
  const found = await addons.streams("movie", "tt0010000");
  result.streamsMs = Math.round(performance.now() - askStart);
  const mine = found.find(one => one.addonName === state.manifest.name);
  if (!mine)
    return { ...result, error: "No streams from the debrid add-on", found: found.map(one => one.addonName) };
  result.streamCount = mine.streams.length;
  const title = stream => stream.name.split("\n").pop();
  const streams = mine.streams.filter(
    stream => !input.only || input.only.some(part => title(stream).includes(part)),
  );

  // 3.
  const hold = input.holdMs || 3000;
  const plays = [];
  await readLog();
  for (const stream of streams) {
    const one = { stream: title(stream), what: stream.description.split("\n").pop() };
    if (stream.silent) one.markedSilent = true;
    const start = performance.now();
    // As the app plays an add-on's stream (src/play/addonPlay.ts, streamOf).
    void player.play({ url: stream.url, startTimeoutMs: 45_000, from: state.manifest.name, redirects: true });
    await waitFor(() => ["playing", "failed"].includes(player.status().state), 60_000);
    const status = player.status();
    one.state = status.state;
    const tookMs = Math.round(performance.now() - start);
    if (status.state === "playing") one.firstPictureMs = tookMs;
    else if (status.state === "failed") Object.assign(one, { error: status.error, failedMs: tookMs });
    else one.error = `still ${status.state} after 60 s`;
    if (status.state === "playing") {
      const at = player.position();
      await sleep(hold);
      // A frozen film fails within FROZEN_MS (10 s) of its first picture.
      if (player.position() === at) {
        await waitFor(() => player.status().state !== "playing", 15_000);
        if (player.status().state === "failed") {
          Object.assign(one, {
            error: player.status().error,
            failedMs: Math.round(performance.now() - start),
          });
        }
      }
      one.movedMs = player.position() - at;
      one.durationS = Math.round(player.duration() / 1000);
      one.formats = player.formats();
      player.refreshTracks();
      one.audio = player
        .tracks()
        .filter(track => track.kind === "audio")
        .map(track => `${track.language ?? "?"}${track.selected ? " (playing)" : ""}`);
      one.subtitles = player
        .tracks()
        .filter(track => track.kind === "text")
        .map(track => track.language ?? "?");
      const seekStart = performance.now();
      player.seek(40_000);
      await waitFor(() => player.position() >= 40_000, 10_000);
      one.seekMs = Math.round(performance.now() - seekStart);
      await sleep(2000);
      one.afterSeekS = Math.round(player.position() / 100) / 10;
      one.stateAfterSeek = player.status().state;
    }
    player.stop();
    const log = await readLog();
    one.requests = {
      resolves: log.filter(entry => entry.kind === "resolve").length,
      redirects: log.filter(entry => entry.kind === "redirect").length,
      files: log.filter(entry => entry.kind === "file").length,
      ranges: log.filter(entry => entry.kind === "file").map(entry => entry.range),
    };
    plays.push(one);
    await sleep(500);
  }
  result.plays = plays;
  return result;
}
