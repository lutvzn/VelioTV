// Measures what the UI costs to draw, page by page, and what each kind of
// visual effect adds to it. It needs a source with channels and a guide, and
// films and series for the Movies and Series steps (those are skipped
// without). About two minutes.
//
// For each screen (full screen with the banner and the channel list, the
// guide with the menu and groups, the guide full screen, the menu open,
// Movies' and Series' groups, posters and title pages, Settings) it reports:
//   - redrawFps: the frame rate while the screen is drawn every frame, as
//     while something on it animates. The TV's GPU (a Mali-G31) is short of
//     fill rate, so a screen that draws too much shows under 60 here. Timing
//     frames with readPixels doesn't work on it: the GPU drops work a later
//     draw covers, and readPixels waits for the screen's refresh.
//   - quads and ops (draw calls) from the renderer's telemetry; the nodes
//     drawn by kind, and those drawn clear (a shader on a see-through
//     colour, which the renderer still draws); and overdraw: the area of
//     everything drawn, in screens.
//   - effects: the redraw rate with one kind of effect taken away: shadows
//     and glows hidden, rounded corners drawn square, images hidden, text
//     hidden, big see-through layers (scrims, washes, backdrops) hidden,
//     clear nodes hidden, and everything but the background hidden.
// Then it moves through the lists, the guide, the posters and the menu with
// the keys, as a user would, and reports the frame rate, the longest frame
// and the renderer's own update and draw times (CPU only).
//
// Input, all optional:
//   "skip": ["series"]   screens to leave out, by name
//   "moves": true        the key-driven part
//   "stopVideo": false   stop the video, and keep the guide's preview from
//                        starting it, while the probe runs. Playing a 50 Hz
//                        channel puts the TV's screen at 50 Hz, which then
//                        caps every rate here at 50; stopped, the screen
//                        goes back to 60 Hz and shows the room left.

async function probe(input) {
  const app = window.velio;
  const R = app?.renderer;
  if (!R) return { error: "window.velio.renderer is missing: deploy the app first" };
  const { skip = [], moves = true, stopVideo = false } = input;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const KEYS = {
    up: 38,
    down: 40,
    left: 37,
    right: 39,
    enter: 13,
    back: 10009,
    info: 457,
    channelDown: 428,
    channelList: 10073,
  };
  const press = keyCode => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
    }
  };
  const waitFor = async (test, ms = 15_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(50);
    }
    return Math.round(performance.now() - start);
  };
  const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
  const median = list => {
    const sorted = list.toSorted((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  const pct = (list, p) => {
    const sorted = list.toSorted((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  };

  // The frame rate while the screen is drawn every frame, as while it
  // animates, as the TV shows it.
  const redrawRate = async (ms = 1500) => {
    let count = 0;
    let running = true;
    const start = performance.now();
    const tick = () => {
      if (!running) return;
      count++;
      R.requestRender();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await sleep(ms);
    running = false;
    return round((count * 1000) / (performance.now() - start));
  };

  // The renderer's telemetry: quads and draw calls, and per-second samples.
  let counts = { quads: 0, renderOps: 0 };
  const samples = [];
  const onRender = (_, payload) => (counts = payload);
  const onFps = (_, payload) => samples.push(payload);
  R.on("renderUpdate", onRender);
  R.on("fpsUpdate", onFps);
  R.setOptions({ fpsUpdateInterval: 1000 });

  // The nodes on screen and drawing something, with what they draw.
  const SCREEN = 1920 * 1080;
  const alphaOf = color => color & 0xff;
  const drawnNodes = () => {
    const found = [];
    const walk = (node, parentAlpha) => {
      const alpha = parentAlpha * node.alpha;
      if (alpha <= 0) return;
      if (node.renderState === 8 && node !== R.root) {
        const isText = typeof node.text === "string";
        const colored =
          alphaOf(node.colorTl) > 0 ||
          alphaOf(node.colorTr) > 0 ||
          alphaOf(node.colorBl) > 0 ||
          alphaOf(node.colorBr) > 0;
        const image = !isText && !!node.src;
        // A shader draws even on a clear colour.
        const clear = !isText && !image && !colored && !!node.shader && node.w !== 0 && node.h !== 0;
        if ((isText && node.text) || image || (!isText && colored) || clear) {
          const shader = node.shader?._rec?.name ?? node.shader?.shaderType?.name ?? "";
          const scaleX = node.scaleX ?? 1;
          const scaleY = node.scaleY ?? 1;
          const x = Math.max(0, node.absX);
          const y = Math.max(0, node.absY);
          const right = Math.min(1920, node.absX + node.w * scaleX);
          const bottom = Math.min(1080, node.absY + node.h * scaleY);
          const area = Math.max(0, right - x) * Math.max(0, bottom - y);
          const opaque =
            !isText &&
            !image &&
            alpha >= 1 &&
            alphaOf(node.colorTl) === 255 &&
            alphaOf(node.colorBr) === 255 &&
            alphaOf(node.colorTr) === 255 &&
            alphaOf(node.colorBl) === 255;
          found.push({ node, isText, image, clear, shader, area, opaque });
        }
      }
      for (const child of node.children) walk(child, alpha);
    };
    walk(R.root, 1);
    return found;
  };
  const describe = nodes => {
    const kinds = {};
    let area = 0;
    let clear = 0;
    for (const one of nodes) {
      if (one.clear) clear++;
      const kind = one.isText ? "text" : one.image ? "image" : one.shader || "plain";
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      area += one.area;
    }
    return { nodes: nodes.length, clear, kinds, overdraw: round(area / SCREEN, 2) };
  };

  // The effects to take away, each a test on a drawn node and a way to undo
  // it: hidden, or drawn as a plain rectangle.
  const isBackground = one =>
    one.node.parent === R.root.children[0] && one.node === one.node.parent.children[0];
  const EFFECTS = {
    shadows: { test: one => /shadow/i.test(one.shader), how: "hide" },
    rounded: {
      test: one => !one.clear && /^rounded/i.test(one.shader) && !/shadow/i.test(one.shader),
      how: "square",
    },
    images: { test: one => one.image, how: "hide" },
    text: { test: one => one.isText, how: "hide" },
    clear: { test: one => one.clear, how: "hide" },
    bigLayers: {
      test: one => !one.isText && !isBackground(one) && one.area >= SCREEN * 0.15 && !one.opaque,
      how: "hide",
    },
    allButBackground: { test: one => !isBackground(one), how: "hide" },
  };
  const without = async (nodes, effect) => {
    const chosen = nodes.filter(effect.test);
    if (chosen.length === 0) return undefined;
    const undo = chosen.map(({ node }) => {
      if (effect.how === "hide") {
        const before = node.alpha;
        node.alpha = 0;
        return () => (node.alpha = before);
      }
      const before = node.shader;
      node.shader = null;
      return () => (node.shader = before);
    });
    const fps = await redrawRate();
    for (const one of undo) one();
    return { nodes: chosen.length, redrawFps: fps };
  };

  const results = { screens: {}, moves: {} };
  const measure = async name => {
    if (skip.includes(name)) return;
    if (stopVideo) app.player.stop();
    // Lets images arrive and transitions end.
    await sleep(1500);
    const nodes = drawnNodes();
    const screen = {
      redrawFps: await redrawRate(),
      quads: counts.quads,
      ops: counts.renderOps,
      ...describe(nodes),
      effects: {},
    };
    for (const [effect, how] of Object.entries(EFFECTS)) {
      const less = await without(nodes, how);
      if (less) screen.effects[effect] = { ...less, gainsFps: round(less.redrawFps - screen.redrawFps) };
    }
    results.screens[name] = screen;
    log(name, screen);
  };

  // Frames as they come while keys are pressed: the rate, the longest gap,
  // and the renderer's update and draw time per frame (CPU only).
  const moving = async (name, steps) => {
    if (skip.includes(name) || !moves) return;
    if (stopVideo) app.player.stop();
    await sleep(1000);
    const gaps = [];
    let last = performance.now();
    let running = true;
    requestAnimationFrame(function count(now) {
      gaps.push(now - last);
      last = now;
      if (running) requestAnimationFrame(count);
    });
    const from = samples.length;
    const start = performance.now();
    await steps();
    await sleep(600);
    running = false;
    const seconds = (performance.now() - start) / 1000;
    const taken = samples.slice(from);
    const drawn = taken.reduce((sum, one) => sum + one.renderedFrames, 0) || 1;
    const out = {
      fps: round(gaps.length / seconds),
      longestFrameMs: Math.round(Math.max(0, ...gaps.slice(1))),
      framesOver20ms: gaps.slice(1).filter(gap => gap > 20).length,
      framesOver50ms: gaps.slice(1).filter(gap => gap > 50).length,
      updateMsPerFrame: round(taken.reduce((sum, one) => sum + one.updateMs, 0) / drawn, 2),
      renderMsPerFrame: round(taken.reduce((sum, one) => sum + one.renderMs, 0) / drawn, 2),
      uploadMs: round(taken.reduce((sum, one) => sum + one.uploadMs, 0)),
      maxUpdateMs: round(Math.max(0, ...taken.map(one => one.maxUpdateMs))),
      maxRenderMs: round(Math.max(0, ...taken.map(one => one.maxRenderMs))),
    };
    results.moves[name] = out;
    log(name, out);
  };
  const repeat = async (key, times, everyMs) => {
    for (let i = 0; i < times; i++) {
      press(key);
      await sleep(everyMs);
    }
  };
  const go = async hash => {
    location.hash = hash;
    await sleep(800);
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

    // Full screen, with the banner.
    await go("#/watch");
    await waitFor(() => app.live);
    await sleep(1000);
    if (!app.live?.bannerShown()) press(KEYS.info);
    results.bannerShown = !!(await waitFor(() => app.live?.bannerShown(), 3000));
    await measure("watchBanner");
    if (app.live?.bannerShown()) press(KEYS.info);
    press(KEYS.channelList);
    results.listOpen = !!(await waitFor(() => app.live?.listOpen(), 3000));
    await measure("watchChannelList");
    await moving("channelListScroll", () => repeat(KEYS.down, 20, 100));
    press(KEYS.back);

    // The guide, from the menu: Right to the groups, Right to the guide.
    await go("#/");
    await waitFor(() => app.guidePage);
    await measure("guideMenuOnly");
    press(KEYS.right);
    await sleep(300);
    // A group whose channels have programmes, as cells cost more than a row
    // saying there's no guide.
    const withProgrammes = () =>
      app.guidePage.rows().filter(row => row?.cells?.some(cell => cell.kind === "programme")).length;
    for (let i = 0; i < 30 && withProgrammes() < 5; i++) {
      press(KEYS.down);
      await sleep(700);
    }
    results.guideRowsWithProgrammes = withProgrammes();
    await measure("guideWithGroups");
    press(KEYS.right);
    await waitFor(() => app.guidePage?.area?.() === "grid", 3000);
    await measure("guideFull");
    await moving("guideScrollRows", () => repeat(KEYS.down, 30, 100));
    await moving("guidePages", () => repeat(KEYS.channelDown, 8, 300));
    await moving("guideAlongTime", async () => {
      await repeat(KEYS.right, 6, 250);
      await repeat(KEYS.left, 6, 250);
    });
    // Back to the groups, and on to the menu, which opens over them.
    press(KEYS.back);
    await sleep(400);
    await moving("groupsUpDown", async () => {
      // Quick presses, which pass groups, and a rest, which shows one.
      await repeat(KEYS.down, 10, 150);
      await sleep(600);
      await repeat(KEYS.up, 10, 150);
      await sleep(600);
    });
    press(KEYS.left);
    await sleep(400);
    await measure("menuOpen");
    // Each section the menu's cursor passes is opened.
    await moving("menuUpDown", async () => {
      // Quick presses, which pass sections, and a rest, which opens one.
      await repeat(KEYS.down, 3, 150);
      await sleep(600);
      await repeat(KEYS.up, 3, 150);
      await sleep(600);
    });

    for (const [section, grid, panel] of [
      ["movies", "moviesGrid", "filmPanel"],
      ["series", "seriesGrid", "seriesPanel"],
    ]) {
      if (skip.includes(section)) continue;
      await go(`#/${section}`);
      await waitFor(() => app[grid]?.items?.().length > 0, 20_000);
      if (!(app[grid]?.items?.().length > 0)) {
        results.screens[section] = "no titles";
        continue;
      }
      press(KEYS.right);
      await sleep(400);
      await measure(`${section}Groups`);
      // Every title, so there's a full grid to move through.
      app[grid].setFilterId("all");
      await waitFor(() => app[grid]?.area?.() === "grid", 3000);
      await measure(`${section}Posters`);
      await moving(`${section}PostersMove`, async () => {
        await repeat(KEYS.right, 6, 200);
        await repeat(KEYS.down, 4, 300);
        await repeat(KEYS.up, 4, 300);
      });
      press(KEYS.enter);
      await waitFor(() => app[panel], 5000);
      await sleep(1500);
      await measure(`${section}Page`);
      press(KEYS.back);
      await sleep(400);
    }

    await go("#/settings");
    press(KEYS.right);
    await measure("settings");
  } finally {
    app.player.play = play;
    R.off("renderUpdate", onRender);
    R.off("fpsUpdate", onFps);
    R.setOptions({ fpsUpdateInterval: 0 });
  }

  // Back to full screen, where the app started.
  location.hash = "#/watch";
  return { done: results };
}
