// Phase 3: plays streams one after another through the app's own player
// (src/player/), as a viewer changing channels would. For each one it records
// how long the first picture took, whether it kept playing, and the longest
// gap between two frames the UI drew while it switched, which shows how long
// the switch blocked the UI. Then it switches quickly, faster than streams can
// start, and checks the last one still plays.
//
// Input:
//   "index": "http://<dev-ip>:8090/"   every test stream from
//       scripts/test-streams/server.mjs, as raw TS and HLS
//   or "streams": [{ "name": "...", "url": "..." }]
// Optional:
//   "kinds": ["ts", "hls"]   which of the index's forms to play
//   "holdSeconds": 3         how long to watch each stream after it starts
//   "rapid": 12              switches in the quick part (0 to skip it)
//   "rapidMs": 300           time between quick switches
//
// With the default input and the test server's 8 streams, it takes about two
// minutes. The video shows full screen on the TV meanwhile.

async function probe(input) {
  const app = window.tiviplayer;
  if (!app?.player) return { error: "window.tiviplayer.player is missing: deploy a newer build" };
  const { player } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log("[probe]", ...args);

  let streams = input.streams;
  if (input.index) {
    const index = await (await fetch(input.index)).json();
    const kinds = input.kinds ?? ["ts", "hls"];
    streams = index.streams.flatMap(s => kinds.map(kind => ({ name: `${s.label} | ${kind}`, url: s[kind] })));
  }
  const holdMs = (input.holdSeconds ?? 3) * 1000;

  // Frame gaps and the frame rate, for the whole run and for each stretch.
  let longestGap = 0;
  let last = performance.now();
  let frames = 0;
  const fps = [];
  let since = last;
  let running = true;
  requestAnimationFrame(function frame(now) {
    longestGap = Math.max(longestGap, now - last);
    last = now;
    frames++;
    if (now - since >= 1000) {
      fps.push(Math.round((frames * 1000) / (now - since)));
      frames = 0;
      since = now;
    }
    if (running) requestAnimationFrame(frame);
  });
  const gapSince = () => {
    const gap = Math.round(longestGap);
    longestGap = 0;
    return gap;
  };

  const memory = [];
  const sampleMemory = () => {
    if (typeof tizen !== "undefined")
      memory.push(Math.round(tizen.systeminfo.getAvailableMemory() / 1048576));
  };
  sampleMemory();
  const memoryTimer = setInterval(sampleMemory, 1000);

  // Waits until the player has started or given up.
  const settled = async (limitMs = 25000) => {
    const end = performance.now() + limitMs;
    while (performance.now() < end) {
      const { state } = player.status();
      if (state !== "starting") return;
      await sleep(50);
    }
  };

  player.setWindow({ x: 0, y: 0, width: 1920, height: 1080 });
  const results = [];
  for (const stream of streams) {
    gapSince();
    await player.play({ url: stream.url });
    await settled();
    const status = player.status();
    const result = {
      name: stream.name,
      state: status.state,
      startMs: status.startMs,
      error: status.error,
      switchGapMs: gapSince(),
    };
    if (status.state === "playing") {
      const from = player.position();
      await sleep(holdMs);
      result.playedMs = player.position() - from;
      result.played = result.playedMs > holdMs * 0.8;
      result.formats = player.formats();
      result.holdGapMs = gapSince();
    } else {
      result.played = false;
    }
    log(result.played ? "played" : "FAILED", stream.name, result.error ?? `${result.startMs} ms`);
    results.push(result);
  }

  let rapid;
  const count = input.rapid ?? 12;
  if (count > 0 && streams.length > 1) {
    gapSince();
    const fpsFrom = fps.length;
    const gaps = [];
    let target;
    for (let i = 0; i < count; i++) {
      target = streams[i % streams.length];
      void player.play({ url: target.url });
      await sleep(input.rapidMs ?? 300);
      gaps.push(gapSince());
    }
    const asked = performance.now();
    await settled();
    const status = player.status();
    const from = player.position();
    await sleep(holdMs);
    rapid = {
      switches: count,
      last: target.name,
      state: status.state,
      stream: status.stream?.url === target.url ? "the last one asked for" : status.stream?.url,
      error: status.error,
      settledMs: Math.round(performance.now() - asked - holdMs),
      played: player.position() - from > holdMs * 0.8,
      longestGapMs: Math.max(...gaps),
      fpsMin: Math.min(...fps.slice(fpsFrom)),
    };
    log("rapid switching:", rapid.played ? "the last stream plays" : "FAILED", rapid.error ?? "");
  }

  player.stop();
  running = false;
  clearInterval(memoryTimer);
  sampleMemory();

  const played = results.filter(r => r.played);
  const starts = played.map(r => r.startMs).toSorted((a, b) => a - b);
  return {
    engine: player.engineName(),
    summary: {
      played: `${played.length} of ${results.length}`,
      startMs: starts.length
        ? { fastest: starts[0], median: starts[Math.floor(starts.length / 2)], slowest: starts.at(-1) }
        : undefined,
      longestSwitchGapMs: Math.max(...results.map(r => r.switchGapMs)),
      fps: {
        min: Math.min(...fps.slice(1)),
        average: Math.round(fps.reduce((a, b) => a + b, 0) / fps.length),
      },
      freeMemoryMb: memory.length
        ? { before: memory[0], lowest: Math.min(...memory), after: memory.at(-1) }
        : undefined,
    },
    rapid,
    results,
  };
}
