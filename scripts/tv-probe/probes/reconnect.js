// Phase 3, step 4: plays the test server's failing streams (server.mjs,
// /fail/) as live channels, and records how the player's status changes:
// what AVPlay reports, how soon it notices, and whether it comes back. The
// Live TV page shows the same status on screen. All of it takes about
// 2.5 minutes; pick some with `cases`.
//
// Input: { "server": "http://<dev-ip>:8090",
//          "cases": ["cut", "stall", "missing", "outage", "outageHls", "hang"] }

async function probe(input) {
  const app = window.velio;
  if (!app?.player) return { error: "window.velio is missing: deploy a newer build" };
  const { player } = app;
  const server = input.server;
  if (!server) return { error: "give the test server as `server`" };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));

  // Every status change, timed from when the stream was asked for.
  const record = async (url, ms, during) => {
    const timeline = [];
    let last = "";
    const started = performance.now();
    const note = () => {
      const { state, error, attempt, reconnects } = player.status();
      const key = [state, error, attempt, reconnects].join("|");
      if (key === last) return;
      last = key;
      timeline.push({ at: Math.round(performance.now() - started), state, error, attempt, reconnects });
    };
    const watcher = setInterval(note, 50);
    void player.play({ url, live: true });
    note();
    await Promise.all([sleep(ms), during?.(started)]);
    clearInterval(watcher);
    note();
    return timeline;
  };

  const cases = {
    // Cut off after 5 s: it should notice and reconnect.
    cut: () => record(`${server}/fail/cut/5/ts/h264-aac.ts`, 20_000),
    // Stops sending after 5 s with the connection open.
    stall: () => record(`${server}/fail/stall/5/ts/h264-aac.ts`, 25_000),
    // 404: what AVPlay reports, and the first few tries.
    missing: () => record(`${server}/fail/status/404/ts/h264-aac.ts`, 9000),
    // Plays, then an 8 s outage cuts it off and refuses it; it should come back.
    outage: () => outage(`${server}/fail/outage/ts/h264-aac.ts`, "seconds=8", 25_000),
    // The same over HLS.
    outageHls: () => outage(`${server}/fail/outage/hls/h264-aac/index.m3u8`, "seconds=8", 25_000),
    // A server that stops sending and leaves new requests unanswered for 25 s.
    hang: () => outage(`${server}/fail/outage/ts/h264-aac.ts`, "seconds=25&hang=1", 45_000),
  };
  async function outage(url, query, ms) {
    return record(url, ms, async () => {
      for (let i = 0; i < 100 && player.status().state !== "playing"; i++) await sleep(100);
      await sleep(2000);
      await fetch(`${server}/fail/outage?${query}`);
    });
  }

  const results = {};
  for (const name of input.cases ?? Object.keys(cases)) {
    results[name] = await cases[name]();
    log(name, results[name]);
  }

  // Back to the channel the Live TV page was showing.
  const channel = app.live?.zapper.playing();
  if (channel) app.live.zapper.tune(channel);
  else player.stop();
  return results;
}
