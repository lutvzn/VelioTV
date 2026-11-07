// Phase 7, step 1: what pausing a live channel does on the TV, when there's
// no catch-up to play on from. For each stream and each pause: it plays live
// on the developer video page (#/dev/video), as a live channel, pauses through the app's
// player, waits, plays on, and watches for 10 s. Takes about 20 s plus the
// pauses, per stream: about 3 minutes with the defaults.
//
// It reports whether play went on from where it paused (the position moves
// on from there), jumped ahead (to live), or failed, and what the player
// said meanwhile (buffering, reconnecting). The test server's live TS is one
// ffmpeg per viewer at the stream's pace, which waits while the TV doesn't
// read; its live HLS keeps the last 12 s, as most live HLS keeps a few
// segments.
//
// Input:
//   "server": "http://<dev-ip>:8090"   the test server (required)
//   "pauses": [10, 60]                 seconds to pause each time
//   "streams": ["ts", "hls"]           which of the two to try

async function probe(input) {
  const app = window.tiviplayer;
  if (!app?.player) return { error: "window.tiviplayer.player is missing" };
  if (!input.server) return { error: 'Give the test server\'s address as "server"' };
  const { player } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const waitFor = async (test, ms = 20_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(50);
    }
    return Math.round(performance.now() - start);
  };
  const urls = {
    ts: `${input.server}/ts/h264-aac.ts`,
    hls: `${input.server}/hls/h264-aac/index.m3u8`,
  };
  const state = () => player.status().state;

  // The developer page shows the video full screen; the probe plays on it as
  // the live page would.
  location.hash = "#/dev/video";
  await sleep(1000);
  const results = [];
  for (const kind of input.streams ?? ["ts", "hls"]) {
    for (const seconds of input.pauses ?? [10, 60]) {
      const url = urls[kind];
      const result = { stream: kind, pauseSeconds: seconds };
      results.push(result);
      void player.play({ url, live: true });
      result.startMs = await waitFor(() => state() === "playing");
      if (result.startMs === undefined) {
        result.error = `didn't play: ${state()} ${player.status().error ?? ""}`;
        continue;
      }
      await sleep(4000);
      player.setPaused(true);
      const pausedAt = player.position();
      result.pausedState = state();
      const states = new Set();
      const during = setInterval(() => states.add(state()), 250);
      await sleep(seconds * 1000);
      clearInterval(during);
      result.statesWhilePaused = [...states];
      result.positionMovedWhilePaused = Math.round((player.position() - pausedAt) / 1000);
      const reconnectsBefore = player.status().reconnects ?? 0;
      player.setPaused(false);
      const resumedAt = performance.now();
      const after = new Set();
      const samples = [];
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        after.add(state());
        samples.push(player.position());
      }
      result.statesAfter = [...after];
      result.reconnects = (player.status().reconnects ?? 0) - reconnectsBefore;
      result.error = player.status().error;
      // Where it went on from: 0 is where it paused; about the pause's
      // length is live again.
      const first = samples.find(at => at > 0) ?? 0;
      result.jumpSeconds = Math.round((first - pausedAt) / 1000);
      result.playedSeconds = Math.round((samples[samples.length - 1] - first) / 1000);
      result.watchedSeconds = Math.round((performance.now() - resumedAt) / 1000);
      log(`${kind} ${seconds}s`, result);
    }
  }
  player.stop();
  location.hash = "#/";
  return { results };
}
