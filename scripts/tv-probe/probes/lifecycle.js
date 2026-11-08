// Phase 3, step 6: hides the app while a channel plays, and records what the
// player does until the app is shown again; then plays a stream through a
// pretend network drop. Something must bring the app back while it waits,
// such as the remote's app list, or from the dev machine:
//   tizen run -s <tv-ip>:26101 -p VelioTVapp.Velio
// It waits up to `hiddenMs` (default 60 s) for that; all of it takes about
// 40 s more.
//
// The network drop is pretend: the probe sends the page `offline` and
// `online` events and has the test server refuse the stream meanwhile, as a
// real drop would cut off the probe too.
//
// Input: { "server": "http://<dev-ip>:8090", "hiddenMs": 60000, "skip": ["hide"|"network"] }

async function probe(input) {
  const app = window.velio;
  if (!app?.player?.suspend || !app?.live)
    return { error: "window.velio.player.suspend is missing: deploy a newer build" };
  const { player, live } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const skip = new Set(input.skip ?? []);

  // Frames drawn, to see whether the page draws again once shown.
  let frames = 0;
  let firstFrameShown;
  let shownAt;
  let counting = true;
  requestAnimationFrame(function count() {
    frames++;
    if (firstFrameShown === undefined && document.visibilityState === "visible" && shownAt !== undefined)
      firstFrameShown = Math.round(performance.now() - shownAt);
    if (counting) requestAnimationFrame(count);
  });

  // Every change of the page's visibility, the network and the player.
  const timeline = [];
  let started = performance.now();
  let last = "";
  const note = () => {
    const { state, error, attempt, startMs, reconnects } = player.status();
    const key = [document.visibilityState, navigator.onLine, state, error, attempt].join("|");
    if (key === last) return;
    last = key;
    timeline.push({
      at: Math.round(performance.now() - started),
      visibility: document.visibilityState,
      online: navigator.onLine,
      state,
      error,
      attempt,
      startMs,
      reconnects,
      frames,
    });
  };
  const watcher = setInterval(note, 50);
  document.addEventListener("visibilitychange", note);
  const waitFor = async (test, ms) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(50);
    }
    return Math.round(performance.now() - start);
  };

  const results = {
    network: {
      onLine: navigator.onLine,
      tizenNetwork: typeof webapis !== "undefined" && Boolean(webapis.network),
    },
  };
  if ((await waitFor(() => player.status().state === "playing", 40_000)) === undefined)
    return { ...results, error: `no channel playing (${player.status().state}): start the app on Live TV` };

  try {
    results.network.type = webapis.network.getActiveConnectionType();
    results.network.gateway = webapis.network.isConnectedToGateway();
  } catch (error) {
    results.network.error = String(error?.name ?? error);
  }

  if (!skip.has("hide")) {
    started = performance.now();
    timeline.length = 0;
    note();
    const channel = live.zapper.playing()?.name;
    tizen.application.getCurrentApplication().hide();
    // The page reports itself hidden about 0.7 s after hide(). Its timers
    // stop while it is hidden, so the waits here count the time hidden too.
    await waitFor(() => document.visibilityState === "hidden", 5000);
    const hiddenFor = await waitFor(() => document.visibilityState === "visible", input.hiddenMs ?? 60_000);
    shownAt = performance.now();
    const playingAfter = await waitFor(() => player.status().state === "playing", 20_000);
    await sleep(500);
    results.hide = {
      channel,
      after: live.zapper.playing()?.name,
      cameBack: hiddenFor !== undefined,
      firstFrameShownMs: firstFrameShown,
      playingAfterShownMs: playingAfter,
      timeline: timeline.splice(0),
    };
    log("hide", results.hide);
  }

  if (!skip.has("network") && input.server) {
    started = performance.now();
    timeline.length = 0;
    void player.play({ url: `${input.server}/fail/outage/ts/h264-aac.ts`, live: true });
    await waitFor(() => player.status().state === "playing", 20_000);
    note();
    // The network goes, and with it the stream, for 15 s.
    window.dispatchEvent(new Event("offline"));
    await fetch(`${input.server}/fail/outage?seconds=15`);
    await sleep(20_000);
    window.dispatchEvent(new Event("online"));
    await waitFor(() => player.status().state === "playing", 20_000);
    await sleep(500);
    results.network.timeline = timeline.splice(0);
    log("network", results.network);
    const channel = live.zapper.playing();
    if (channel) live.zapper.tune(channel);
  }

  clearInterval(watcher);
  counting = false;
  document.removeEventListener("visibilitychange", note);
  return results;
}
