// Phase 3, step 7: watches Live TV for a long time as a viewer would,
// zapping up through the channels with the remote's Up key, and now and then
// staying on one for longer. It records each channel's time to first picture
// and what went wrong, the TV's free memory and the app's JS heap, and the
// UI's frame rate, and logs a line a minute as it goes.
//
// Channels whose stream fails on purpose (the test server's /fail/ URLs) are
// counted apart: they are meant to reconnect or fail.
//
// Start the app on Live TV, full screen. A run longer than 15 minutes needs a
// longer limit for the runner, such as PROBE_TIMEOUT=4000 for an hour.
//
// Input (all optional):
//   "minutes": 10          how long to run
//   "zapSeconds": 15       time on each channel
//   "watchEvery": 10       every this many channels, stay longer...
//   "watchSeconds": 120    ...for this long

async function probe(input) {
  const app = window.tiviplayer;
  if (!app?.player || !app?.live) return { error: "window.tiviplayer.live is missing: deploy a newer build" };
  const { player, live } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const minutes = input.minutes ?? 10;
  const zapMs = (input.zapSeconds ?? 15) * 1000;
  const watchEvery = input.watchEvery ?? 10;
  const watchMs = (input.watchSeconds ?? 120) * 1000;
  const waitFor = async (test, ms) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(50);
    }
    return Math.round(performance.now() - start);
  };
  const press = keyCode => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
    }
  };
  const UP = 38;

  if ((await waitFor(() => live.watching() && player.status().state === "playing", 40_000)) === undefined)
    return {
      error: `Live TV isn't playing full screen (${player.status().state}): start the app on Live TV`,
    };

  const started = performance.now();
  const elapsedS = () => Math.round((performance.now() - started) / 1000);
  const mb = bytes => Math.round(bytes / 1048576);
  const freeMemory = () => {
    try {
      return mb(tizen.systeminfo.getAvailableMemory());
    } catch {
      return undefined;
    }
  };
  const heap = () => (performance.memory ? mb(performance.memory.usedJSHeapSize) : undefined);

  // Frames: the rate for each second, and the longest gap.
  let frames = 0;
  let second = performance.now();
  let lastFrame = second;
  let minuteFps = [];
  let minuteGap = 0;
  let running = true;
  requestAnimationFrame(function frame(now) {
    minuteGap = Math.max(minuteGap, now - lastFrame);
    lastFrame = now;
    frames++;
    if (now - second >= 1000) {
      minuteFps.push(Math.round((frames * 1000) / (now - second)));
      frames = 0;
      second = now;
    }
    if (running) requestAnimationFrame(frame);
  });

  // Every change of the player's state, while on the current channel.
  let seen = [];
  let lastKey = "";
  const watcher = setInterval(() => {
    const { state, error } = player.status();
    const key = `${state}|${error}`;
    if (key === lastKey) return;
    lastKey = key;
    seen.push({ state, error });
  }, 100);

  const zaps = [];
  const minutesLog = [];
  const memory = [{ at: 0, free: freeMemory(), heap: heap() }];
  let nextMinute = 60;
  const minuteLine = () => {
    const fps = minuteFps;
    minuteFps = [];
    const line = {
      minute: minutesLog.length + 1,
      zaps: zaps.length,
      free: freeMemory(),
      heap: heap(),
      fpsAvg: fps.length ? Math.round(fps.reduce((a, b) => a + b, 0) / fps.length) : undefined,
      fpsLow: fps.length ? Math.min(...fps) : undefined,
      longestFrameMs: Math.round(minuteGap),
      state: player.status().state,
    };
    minuteGap = 0;
    minutesLog.push(line);
    memory.push({ at: elapsedS(), free: line.free, heap: line.heap });
    log("minute", line);
  };
  // Sleeps in steps, writing the minute lines on time.
  const hold = async ms => {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      await sleep(Math.min(1000, until - performance.now()));
      if (elapsedS() >= nextMinute) {
        nextMinute += 60;
        minuteLine();
      }
    }
  };

  while (elapsedS() < minutes * 60) {
    const long = watchEvery > 0 && (zaps.length + 1) % watchEvery === 0;
    seen = [];
    lastKey = "";
    const pressed = performance.now();
    press(UP);
    // The zapper plays a channel 400 ms after the last press.
    const tuneMs = await waitFor(() => !live.zapper.pending(), 2000);
    const channel = live.zapper.playing();
    await waitFor(() => ["playing", "failed"].includes(player.status().state), Math.min(25_000, zapMs));
    const firstPicture =
      player.status().state === "playing" ? Math.round(performance.now() - pressed) : undefined;
    await hold(Math.max(0, (long ? watchMs : zapMs) - (performance.now() - pressed)));
    const status = player.status();
    const url = status.stream?.url ?? "";
    zaps.push({
      n: zaps.length + 1,
      channel: channel?.name,
      kind: url.includes(".m3u8") ? "hls" : "ts",
      onPurpose: url.includes("/fail/"),
      long,
      tuneMs,
      startMs: status.startMs,
      firstPicture,
      end: status.state,
      reconnects: status.reconnects ?? 0,
      errors: seen.filter(one => one.error).map(one => one.error),
    });
  }
  minuteLine();
  clearInterval(watcher);
  running = false;

  // A summary of the start times and failures, apart from the failing channels.
  const normal = zaps.filter(zap => !zap.onPurpose);
  const spread = list => {
    const sorted = list.filter(value => value !== undefined);
    sorted.sort((a, b) => a - b);
    if (!sorted.length) return undefined;
    const at = share => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
    return {
      count: sorted.length,
      min: sorted[0],
      median: at(0.5),
      p90: at(0.9),
      max: sorted[sorted.length - 1],
    };
  };
  const errors = {};
  for (const zap of normal) for (const error of zap.errors) errors[error] = (errors[error] ?? 0) + 1;
  const frees = memory.map(one => one.free).filter(value => value !== undefined);
  const heaps = memory.map(one => one.heap).filter(value => value !== undefined);
  return {
    minutes: Math.round(elapsedS() / 6) / 10,
    zaps: zaps.length,
    normal: {
      zaps: normal.length,
      playingAtEnd: normal.filter(zap => zap.end === "playing").length,
      notPlaying: normal.filter(zap => zap.end !== "playing"),
      withErrors: normal.filter(zap => zap.errors.length).length,
      errors,
      startMs: {
        ts: spread(normal.filter(z => z.kind === "ts").map(z => z.startMs)),
        hls: spread(normal.filter(z => z.kind === "hls").map(z => z.startMs)),
      },
      pressToPictureMs: spread(normal.map(zap => zap.firstPicture)),
    },
    onPurpose: zaps
      .filter(zap => zap.onPurpose)
      .map(zap => ({
        n: zap.n,
        channel: zap.channel,
        end: zap.end,
        reconnects: zap.reconnects,
        errors: zap.errors,
      })),
    freeMemoryMb: { first: frees[0], lowest: Math.min(...frees), last: frees[frees.length - 1] },
    heapMb: { first: heaps[0], highest: Math.max(...heaps), last: heaps[heaps.length - 1] },
    perMinute: minutesLog,
  };
}
