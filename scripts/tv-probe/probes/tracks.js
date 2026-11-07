// Phase 3, step 5: picks audio and subtitle tracks through the Live TV
// page's track panel with remote key presses, on the test server's tracks
// stream (two audio tracks, English and German subtitles over HLS), and
// reports what played and showed. Then it plays the raw TS version to check
// the choice carries over. It puts the app's remembered choice back after.
// Watch the TV while it runs; it takes about 40 s.
//
// Input: { "server": "http://<dev-ip>:8090" }

async function probe(input) {
  const app = window.tiviplayer;
  if (!app?.player || !app?.live?.rows)
    return { error: "window.tiviplayer.live.rows is missing: deploy a newer build" };
  const { player, live } = app;
  const server = input.server;
  if (!server) return { error: "give the test server as `server`" };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const KEYS = { up: 38, down: 40, left: 37, right: 39, enter: 13, back: 10009 };
  const press = keyCode => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
    }
  };
  const waitFor = async (test, ms = 20_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(20);
    }
    return Math.round(performance.now() - start);
  };

  // The longest gap between frames, around each choice.
  let longest = 0;
  let last = performance.now();
  let running = true;
  requestAnimationFrame(function count(now) {
    longest = Math.max(longest, now - last);
    last = now;
    if (running) requestAnimationFrame(count);
  });

  // Subtitle text as drawn, with when it appeared.
  const shown = [];
  let lastText;
  const started = performance.now();
  const watcher = setInterval(() => {
    const text = player.subtitle();
    if (text === lastText) return;
    lastText = text;
    if (text) shown.push({ at: Math.round(performance.now() - started), text });
  }, 20);

  const panel = () =>
    live.rows().map((row, at) => {
      const mark = row.type === "choice" ? (row.selected ? "* " : "  ") : "# ";
      return `${at === live.trackCursor() ? ">" : " "}${mark}${row.text}`;
    });
  const selected = () =>
    player
      .tracks()
      .filter(track => track.selected)
      .map(track => `${track.kind} ${track.language ?? track.id}`);
  const moveTo = async text => {
    for (let i = 0; i < 10 && live.rows()[live.trackCursor()]?.text !== text; i++) {
      press(KEYS.down);
      await sleep(150);
    }
    return live.rows()[live.trackCursor()]?.text === text;
  };
  const choose = async text => {
    const reached = await moveTo(text);
    longest = 0;
    const before = performance.now();
    press(KEYS.enter);
    const pressMs = Math.round(performance.now() - before);
    await sleep(300);
    return { reached, pressMs, longestFrameMs: Math.round(longest), selected: selected() };
  };
  // Plays a stream, and times its tracks' listing from the first picture.
  const play = async url => {
    void player.play({ url, live: true });
    await waitFor(() => player.status().state === "playing");
    const tracksAfterMs = await waitFor(() => player.tracks().length > 0, 5000);
    await sleep(500);
    return {
      state: player.status().state,
      startMs: player.status().startMs,
      tracksAfterMs,
      selected: selected(),
    };
  };

  const saved = localStorage.getItem("tiviplayer.tracks");
  localStorage.removeItem("tiviplayer.tracks");
  await waitFor(() => live.watching(), 15_000);
  const results = { watching: live.watching() };
  if (!results.watching) return { error: "Live TV isn't full screen: start the app on Live TV" };

  results.hls = await play(`${server}/hls/h264-tracks/index.m3u8`);
  press(KEYS.right);
  await sleep(500);
  results.hls.panelOpen = live.tracksOpen();
  results.hls.panel = panel();
  log("hls", results.hls);

  results.german = await choose("German");
  log("german audio", results.german);
  results.englishSubtitles = await choose("English");
  await sleep(3500);
  results.englishSubtitles.shown = shown.splice(0);
  log("english subtitles", results.englishSubtitles);
  results.germanSubtitles = await choose("German");
  await sleep(3500);
  results.germanSubtitles.shown = shown.splice(0);
  log("german subtitles", results.germanSubtitles);
  press(KEYS.up);
  await sleep(150);
  press(KEYS.up);
  await sleep(150);
  results.off = await choose("Off");
  await sleep(2000);
  results.off.shown = shown.splice(0);
  results.off.panel = panel();
  log("off", results.off);
  press(KEYS.back);
  await sleep(300);
  results.closedByBack = !live.tracksOpen();
  results.remembered = localStorage.getItem("tiviplayer.tracks");

  // The raw TS version: German audio again, by itself.
  results.ts = await play(`${server}/ts/h264-tracks.ts`);
  press(KEYS.right);
  await sleep(500);
  results.ts.panel = panel();
  press(KEYS.back);
  await sleep(300);
  log("ts", results.ts);

  clearInterval(watcher);
  running = false;
  if (saved === null) localStorage.removeItem("tiviplayer.tracks");
  else localStorage.setItem("tiviplayer.tracks", saved);
  const channel = live.zapper.playing();
  if (channel) live.zapper.tune(channel);
  return results;
}
