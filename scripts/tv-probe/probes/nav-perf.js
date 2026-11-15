// How fast navigating is, press by press, for catching slowdowns: run it
// with scripts/tv-probe/nav-perf.mjs, which compares the result with the
// numbers kept in scripts/tv-probe/baselines/nav-perf.json (PLAN.md,
// "Navigation speed"). It needs a source with channels and a guide, and films
// and series for those steps (skipped without). About 105 s.
//
// Each step presses keys one at a time, as a user would, and for each press
// times:
//   - inputMs: the app's own work for the key (the key's handlers);
//   - frameMs: from the key until the frame showing it is drawn;
//   - settleMs: until the last frame it causes (animations done, and what a
//     timer builds later, such as a group opened once the cursor rests),
//     capped at 2.5 s.
// and reports their median and highest, and the longest frame meanwhile.
// "Open" steps (a section from the menu, a group, a title's page) time the
// key until what it opens has drawn and settled. "Rapid" steps press 20
// keys 100 ms apart and report the frame rate and the longest frame.
// It also counts the renderer's nodes on each screen, and the JS heap.
//
// Input, all optional:
//   "skip": ["series"]   steps to leave out, by name or prefix
//   "stopVideo": true    stop the video for the run, as 50 Hz video holds
//                        frames at 20 ms (see ui-perf)
//   "repeat": 1          runs of each press step (more for steadier numbers)

async function probe(input) {
  const app = window.velio;
  const R = app?.renderer;
  if (!R) return { error: "window.velio.renderer is missing: deploy the app first" };
  const { skip = [], stopVideo = true, repeat = 1 } = input;
  const skipped = name => skip.some(one => name === one || name.startsWith(one));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const KEYS = { up: 38, down: 40, left: 37, right: 39, enter: 13, back: 10009, channelDown: 428 };
  const press = keyCode => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
    }
  };
  const waitFor = async (test, ms = 15_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(30);
    }
    return Math.round(performance.now() - start);
  };
  const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
  const sorted = list => list.toSorted((a, b) => a - b);
  const median = list => sorted(list)[Math.floor(list.length / 2)] ?? 0;
  const max = list => Math.max(0, ...list);
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve(performance.now())));

  // Frames as the renderer draws them. The renderer doesn't always say when
  // it goes to sleep, so it has settled once no frame has come for QUIET ms
  // (longer than the menu's and groups' rest, CURSOR_REST_MS, so what opens
  // after it counts).
  const QUIET = 300;
  let lastTickAt = 0;
  const onTick = () => (lastTickAt = performance.now());
  R.on("frameTick", onTick);
  // The gaps between the browser's frames, which come every refresh whether
  // the renderer draws or not: a long one is the app stalled (its code, or
  // the GPU behind on what it drew).
  let frames = [];
  let lastFrame = 0;
  let watching = true;
  requestAnimationFrame(function watch() {
    const now = performance.now();
    if (lastFrame) frames.push(now - lastFrame);
    lastFrame = now;
    if (watching) requestAnimationFrame(watch);
  });

  // From `since` until the last frame before a quiet spell, or `cap` ms.
  const settled = async (since, cap = 2500) => {
    for (;;) {
      const now = performance.now();
      if (now - since > cap) return { ms: cap, capped: true };
      if (now - Math.max(lastTickAt, since) >= QUIET)
        return { ms: Math.max(0, lastTickAt - since), capped: false };
      await sleep(15);
    }
  };

  // One key, timed.
  const timePress = async key => {
    await settled(performance.now(), 1000);
    frames = [];
    const start = performance.now();
    press(key);
    const handled = performance.now() - start;
    const frame = (await nextFrame()) - start;
    const settle = await settled(start);
    return { input: handled, frame, settle: settle.ms, capped: settle.capped, longest: max(frames) };
  };

  const results = { steps: {}, screens: {} };
  const summarize = (name, presses) => {
    const out = {
      presses: presses.length,
      inputMsMedian: round(median(presses.map(one => one.input))),
      inputMsMax: round(max(presses.map(one => one.input))),
      frameMsMedian: round(median(presses.map(one => one.frame))),
      frameMsMax: round(max(presses.map(one => one.frame))),
      settleMsMedian: Math.round(median(presses.map(one => one.settle))),
      settleMsMax: Math.round(max(presses.map(one => one.settle))),
      longestFrameMs: Math.round(max(presses.map(one => one.longest))),
      capped: presses.filter(one => one.capped).length,
    };
    results.steps[name] = out;
    log(name, out);
  };
  const presses = async (name, keys) => {
    if (skipped(name)) {
      for (const key of keys) press(key);
      await sleep(400);
      return;
    }
    const all = [];
    for (let run = 0; run < repeat; run++) {
      for (const key of keys) all.push(await timePress(key));
    }
    summarize(name, all);
  };
  // A key that opens something: timed until `ready`, then until it settles.
  const opens = async (name, key, ready) => {
    await settled(performance.now(), 1000);
    frames = [];
    const start = performance.now();
    press(key);
    const handled = performance.now() - start;
    const frame = (await nextFrame()) - start;
    const readyMs = await waitFor(ready, 10_000);
    const settle = await settled(start, 5000);
    if (skipped(name)) return readyMs !== undefined;
    const out = {
      inputMs: round(handled),
      frameMs: round(frame),
      readyMs: readyMs ?? "never",
      settleMs: Math.round(settle.ms),
      capped: settle.capped,
      longestFrameMs: Math.round(max(frames)),
    };
    results.steps[name] = out;
    log(name, out);
    return readyMs !== undefined;
  };
  // Keys 100 ms apart, as when moving quickly.
  const rapid = async (name, key, times = 20) => {
    if (skipped(name)) return;
    await settled(performance.now(), 1000);
    frames = [];
    const start = performance.now();
    for (let i = 0; i < times; i++) {
      press(key);
      await sleep(100);
    }
    await settled(performance.now(), 1500);
    const seconds = (performance.now() - start) / 1000;
    const out = {
      fps: round(frames.length / seconds),
      longestFrameMs: Math.round(max(frames)),
      framesOver20ms: frames.filter(gap => gap > 20).length,
      framesOver50ms: frames.filter(gap => gap > 50).length,
    };
    results.steps[name] = out;
    log(name, out);
  };
  const countNodes = node => node.children.reduce((sum, child) => sum + countNodes(child), 1);
  const screen = name => {
    if (skipped(name)) return;
    results.screens[name] = countNodes(R.root);
  };
  const menuTo = async path => {
    const at = ["/", "/movies", "/series", "/settings"].indexOf(path);
    const from = ["/", "/movies", "/series", "/settings"].indexOf(location.hash.slice(1) || "/");
    for (let i = 0; i < Math.abs(at - from); i++) {
      press(at > from ? KEYS.down : KEYS.up);
      await sleep(150);
    }
  };

  const play = app.player.play;
  if (stopVideo) {
    app.player.play = () => Promise.resolve();
    app.player.stop();
    // The screen takes a moment to go back to 60 Hz.
    await sleep(3000);
  }
  try {
    await waitFor(() => app.lineup.channels().length > 0, 30_000);
    location.hash = "#/";
    await waitFor(() => app.guidePage, 10_000);
    await sleep(1500);
    screen("guide");

    // The guide: the groups, a group opened, the rows, along time, pages.
    press(KEYS.right);
    await sleep(500);
    await presses("groupsMove", [KEYS.down, KEYS.down, KEYS.down, KEYS.up, KEYS.up, KEYS.up]);
    // Down and Right at once shows the next group, with the keys in the guide.
    press(KEYS.down);
    await opens("groupOpen", KEYS.right, () => app.guidePage.area() === "grid");
    await sleep(500);
    screen("guideFull");
    await presses("guideRows", [...Array(8).fill(KEYS.down), ...Array(8).fill(KEYS.up)]);
    await presses("guideTime", [KEYS.right, KEYS.right, KEYS.right, KEYS.left, KEYS.left, KEYS.left]);
    await presses("guidePages", [KEYS.channelDown, KEYS.channelDown, KEYS.channelDown]);
    await rapid("guideRowsRapid", KEYS.down);
    // Back to the groups, then the menu.
    press(KEYS.back);
    await sleep(400);
    await presses("menuFromGroups", [KEYS.left]);
    screen("menu");
    await presses("menuMove", [KEYS.down, KEYS.down, KEYS.down, KEYS.up, KEYS.up, KEYS.up]);

    // Each section, opened from the menu with OK.
    const SECTIONS = {
      movies: () => app.moviesGrid?.items?.().length > 0,
      series: () => app.seriesGrid?.items?.().length > 0,
      settings: () => !!app.settingsPage,
    };
    for (const section of ["movies", "series", "settings"]) {
      const ready = SECTIONS[section];
      await menuTo(`/${section}`);
      // A rest on the menu first, as a user's, in which the app joins the
      // titles ahead (warmTitlesLater, src/pages/vod/modernTitles.ts).
      await sleep(section === "settings" ? 400 : 2600);
      const opened = await opens(`open-${section}`, KEYS.enter, ready);
      if (!opened) {
        results.steps[`open-${section}`] = "nothing to show";
        continue;
      }
      await sleep(800);
      screen(section);
      if (section === "settings") {
        press(KEYS.right);
        await sleep(400);
        await presses("settingsMove", [KEYS.down, KEYS.down, KEYS.down, KEYS.up, KEYS.up, KEYS.up]);
        press(KEYS.left);
        await sleep(300);
        press(KEYS.left);
        await sleep(400);
        continue;
      }
      const grid = app[`${section}Grid`];
      press(KEYS.right);
      await sleep(400);
      await presses(`${section}Groups`, [KEYS.down, KEYS.down, KEYS.up, KEYS.up]);
      await opens(`${section}GroupOpen`, KEYS.right, () => grid.area() === "grid");
      await sleep(800);
      screen(`${section}Posters`);
      await presses(`${section}Posters`, [
        KEYS.right,
        KEYS.right,
        KEYS.right,
        KEYS.down,
        KEYS.down,
        KEYS.up,
        KEYS.up,
        KEYS.left,
        KEYS.left,
        KEYS.left,
      ]);
      await rapid(`${section}PostersRapid`, KEYS.right, 12);
      const panel = section === "movies" ? "filmPanel" : "seriesPanel";
      await opens(`${section}TitleOpen`, KEYS.enter, () => !!app[panel]);
      await sleep(800);
      screen(`${section}Title`);
      await opens(`${section}TitleBack`, KEYS.back, () => !app[panel]);
      await sleep(300);
      // Down the rows of every title quickly, and back up, as the rows slide.
      grid.setFilterId("all");
      await sleep(1500);
      for (const [name, key] of [
        [`${section}RowsRapid`, KEYS.down],
        [`${section}RowsUpRapid`, KEYS.up],
      ]) {
        const from = grid.cursor();
        await rapid(name, key, 10);
        if (results.steps[name]) results.steps[name].moved = grid.cursor() - from;
      }
      // Back to the groups, then the menu.
      press(KEYS.back);
      await sleep(300);
      press(KEYS.back);
      await sleep(400);
    }

    await menuTo("/");
    await sleep(300);
    await opens("open-live", KEYS.enter, () => !!app.guidePage);
    const heap = typeof performance.memory === "object" ? performance.memory : undefined;
    results.endedOn = location.hash;
    if (heap) results.heapMB = round(heap.usedJSHeapSize / 1e6);
  } finally {
    app.player.play = play;
    R.off("frameTick", onTick);
    watching = false;
  }
  return { done: results };
}
