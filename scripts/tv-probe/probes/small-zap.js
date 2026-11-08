// Phase 7: whether zapping the main channel to some stream formats takes the
// small window's picture away. The small window plays one test stream on the
// live page; the main channel then zaps through a channel for each test
// stream (scripts/test-streams/streams.mjs), over raw TS and HLS, 8 s each.
// After each zap it records whether the small one still moves on, its state
// and reconnects, and how long the main one took. It needs the test
// server's plain playlist source. About 8 s per stream: 2.5 minutes with
// the defaults. Watch the TV meanwhile: the main picture's label says which
// stream each step is on; note when the small window goes empty.
//
// Input, all optional:
//   "small": "hls/h264-aac"           the small window's stream
//   "kinds": ["ts", "hls"]            transports for the main channel; "fail"
//                                     for the channels that fail on purpose
//   "streams": ["hevc-aac", ...]      only these test streams
//   "seconds": 8                      time on each
//   "locked": true                    first zap to a locked channel (Phase 5's
//                                     PIN); the small window must still show

async function probe(input) {
  const app = window.velio;
  if (!app?.secondPlayer) return { error: "window.velio.secondPlayer is missing: deploy the app first" };
  const { lineup, player, secondPlayer } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const waitFor = async (test, ms = 15_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(50);
    }
    return Math.round(performance.now() - start);
  };
  const live = () => app.live;
  await waitFor(() => lineup.channels().length > 0, 30_000);
  const channels = lineup.channels();
  // "ts/<id>" or "hls/<id>", or "fail/<how>" for a channel that fails on purpose.
  const path = channel => {
    const failing = /\/fail\/([a-z]+)/.exec(channel.url);
    if (failing) return `fail/${failing[1]}`;
    const match = /\/(ts|hls)\/([^/.?]+)/.exec(channel.url);
    return match ? `${match[1]}/${match[2]}` : undefined;
  };
  const byPath = new Map();
  for (const channel of channels) {
    const at = path(channel);
    if (at && !byPath.has(at) && !channel.catchup) byPath.set(at, channel);
  }
  const small = byPath.get(input.small ?? "hls/h264-aac");
  const start = byPath.get("ts/h264-aac");
  if (!small || !start)
    return { error: "No test-server channels for the small window", paths: [...byPath.keys()] };

  location.hash = "#/watch";
  await waitFor(() => live()?.zapper, 5000);
  live().zapper.tune(start, live().zapper.group());
  await waitFor(() => player.status().state === "playing");
  live()
    .smallOptions(small)
    .find(option => option.id === "smallOpen")
    ?.run();
  if ((await waitFor(() => secondPlayer.status().state === "playing")) === undefined) {
    return { error: `The small window didn't play: ${secondPlayer.status().state}` };
  }
  await sleep(2000);

  const wanted = [...byPath.keys()].filter(
    at =>
      (input.kinds ?? ["ts", "hls"]).includes(at.split("/")[0]) &&
      (!input.streams || input.streams.includes(at.split("/")[1])) &&
      at !== "ts/h264-aac",
  );
  const steps = [];
  const locked = input.locked && channels.find(channel => app.isBlocked(channel));
  if (input.locked && !locked) return { error: "No locked channel" };
  if (locked) byPath.set("locked", locked);
  for (const at of [...(locked ? ["locked"] : []), ...wanted, "ts/h264-aac"]) {
    const channel = byPath.get(at);
    const before = secondPlayer.status().reconnects ?? 0;
    const step = { main: at };
    steps.push(step);
    const zapped = performance.now();
    live().zapper.tune(channel, live().zapper.group());
    const ms = await waitFor(
      () =>
        live().zapper.playing()?.id === channel.id &&
        (player.status().state === "playing" || (at === "locked" && live().lockedChannel())),
    );
    step.mainMs =
      ms === undefined
        ? `not playing: ${player.status().state} ${player.status().error ?? ""}`
        : Math.round(performance.now() - zapped);
    await sleep(Math.max(0, (input.seconds ?? 8) * 1000 - 3000 - (performance.now() - zapped)));
    const was = secondPlayer.position();
    await sleep(3000);
    step.smallMoves = secondPlayer.position() - was > 2000;
    step.smallState = secondPlayer.status().state;
    step.smallReconnects = (secondPlayer.status().reconnects ?? 0) - before;
    if (secondPlayer.status().error) step.smallError = secondPlayer.status().error;
    step.smallOpen = Boolean(live().smallChannel());
    // Where the background lets video through: the main window, or else the small one's.
    const hole = app.videoWindow() ?? app.smallVideoWindow();
    step.hole = hole ? `${hole.x},${hole.y} ${hole.width}x${hole.height}` : "none";
    log(at, step);
  }
  live()
    .smallOptions(live().zapper.playing())
    .find(option => option.id === "smallClose")
    ?.run();
  return { small: input.small ?? "hls/h264-aac", steps };
}
