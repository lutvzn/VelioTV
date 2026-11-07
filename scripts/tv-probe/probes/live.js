// Phase 3, step 3: drives the Live TV page with remote key presses, as a
// user would, and reports what played and how smooth the UI stayed. It needs
// a source with channels (see the `sources` probe). Watch the TV while it
// runs; it takes about a minute.
//
// It checks, in order: that the app started full screen on a channel; a fast
// run of zaps (only the last should open); single zaps, timed from the press
// to the first picture; scrolling the channel list and picking from it;
// picking a channel by number; and Back out to the menu.
//
// Input, all optional: { "rapid": 8, "rapidMs": 150, "single": 3, "number": "12" }

async function probe(input) {
  const app = window.tiviplayer;
  if (!app?.player || !app?.lineup || !app?.live)
    return { error: "window.tiviplayer.live is missing: deploy a newer build" };
  const { player, lineup } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const KEYS = { up: 38, down: 40, left: 37, right: 39, enter: 13, back: 10009 };
  const press = keyCode => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
    }
  };
  const digitKey = digit => 48 + Number(digit);

  // Frame rate, and the longest gap between frames.
  const frames = { count: 0, since: performance.now(), fps: [], last: performance.now(), longest: 0 };
  let running = true;
  requestAnimationFrame(function count(now) {
    frames.count++;
    frames.longest = Math.max(frames.longest, now - frames.last);
    frames.last = now;
    if (now - frames.since >= 1000) {
      frames.fps.push(Math.round((frames.count * 1000) / (now - frames.since)));
      frames.count = 0;
      frames.since = now;
    }
    if (running) requestAnimationFrame(count);
  });
  const section = () => {
    const out = { fps: frames.fps.slice(), longestFrameMs: Math.round(frames.longest) };
    frames.fps = [];
    frames.longest = 0;
    return out;
  };

  // The page's own state (src/pages/LiveTv.tsx). Test channels share stream
  // URLs, so the channel playing comes from the page, not the stream.
  const live = () => app.live;
  const playing = () => live()?.zapper.playing();
  const playingName = () => playing()?.name;
  const state = () => player.status();
  const waitFor = async (test, ms = 20_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(20);
    }
    return Math.round(performance.now() - start);
  };
  const settled = () => ["playing", "failed", "ended"].includes(state().state);

  const results = {};
  // Start: the app opens Live TV full screen on the last channel.
  await waitFor(() => state().state !== "idle", 15_000);
  await waitFor(settled);
  results.start = {
    fullScreen: live().watching(),
    channels: lineup.channels().length,
    channel: playingName(),
    state: state().state,
    error: state().error,
    startMs: state().startMs,
  };
  log("start", results.start);
  await sleep(1500);
  section();

  // A fast run of zaps: the banner follows each, only the last should open.
  const rapid = input.rapid ?? 8;
  const opened = new Set();
  const watcher = setInterval(() => opened.add(playing()?.id), 10);
  const before = playing()?.id;
  for (let i = 0; i < rapid; i++) {
    press(KEYS.up);
    await sleep(input.rapidMs ?? 150);
  }
  const lastPress = performance.now();
  await waitFor(() => playing()?.id !== before, 3000);
  const switchedAfterMs = Math.round(performance.now() - lastPress);
  await waitFor(settled);
  clearInterval(watcher);
  opened.delete(before);
  results.rapid = {
    presses: rapid,
    streamsOpened: opened.size,
    switchedAfterMs,
    channel: playingName(),
    state: state().state,
    startMs: state().startMs,
    ...section(),
  };
  log("rapid", results.rapid);

  // Single zaps down, each timed from the press to its first picture.
  results.single = [];
  for (let i = 0; i < (input.single ?? 3); i++) {
    await sleep(1500);
    section();
    const from = playing()?.id;
    const pressed = performance.now();
    press(KEYS.down);
    await waitFor(() => playing()?.id !== from, 3000);
    await waitFor(settled);
    const one = {
      channel: playingName(),
      state: state().state,
      error: state().error,
      pressToPictureMs: state().state === "playing" ? Math.round(performance.now() - pressed) : undefined,
      startMs: state().startMs,
      ...section(),
    };
    results.single.push(one);
    log("zap", one);
  }

  // The channel list: open it, scroll, change group, pick a channel.
  await sleep(1000);
  section();
  press(KEYS.enter);
  await sleep(500);
  log("list opened", { at: Math.round(performance.now()) });
  for (let i = 0; i < 30; i++) {
    press(KEYS.down);
    await sleep(100);
  }
  const scrolled = section();
  log("list scrolled", scrolled);
  press(KEYS.right);
  await sleep(500);
  log("group changed", section());
  press(KEYS.down);
  await sleep(300);
  const listFrom = playing()?.id;
  press(KEYS.enter);
  await waitFor(() => playing()?.id !== listFrom, 3000);
  await waitFor(settled);
  results.list = {
    scrolling: scrolled,
    listClosed: !live().listOpen(),
    picked: playingName(),
    group: live().zapper.group(),
    state: state().state,
    startMs: state().startMs,
  };
  log("list", results.list);

  // A channel by number.
  await sleep(1500);
  const number = String(input.number ?? "12");
  const numberFrom = playing()?.id;
  for (const digit of number) {
    press(digitKey(digit));
    await sleep(200);
  }
  press(KEYS.enter);
  await waitFor(() => playing()?.id !== numberFrom, 3000);
  await waitFor(settled);
  results.number = {
    typed: number,
    channel: playingName(),
    channelNumber: playing() && live().zapper.numberOf(playing()),
    state: state().state,
  };
  log("number", results.number);

  // Back closes the banner, then leaves full screen for the menu. (Back on
  // the menu closes the app, so it stops as soon as full screen ends.)
  await sleep(1000);
  let backPresses = 0;
  while (live().watching() && backPresses < 4) {
    press(KEYS.back);
    backPresses++;
    await sleep(400);
  }
  results.back = {
    presses: backPresses,
    fullScreen: live().watching(),
    state: state().state,
    stillPlaying: playingName(),
  };
  log("back", results.back);
  // And Right goes full screen again.
  press(KEYS.right);
  await sleep(500);
  results.back.fullScreenAgain = live().watching();

  running = false;
  return results;
}
