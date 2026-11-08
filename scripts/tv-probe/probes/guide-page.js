// Phase 4: drives the TV guide with remote key presses, as a user would, and
// reports how smooth it stayed and whether each step did what it should. It
// needs a source with channels and a guide (see the `sources` probe), and
// starts from the app's start, full screen. Watch the TV while it runs; it
// takes about a minute.
//
// In order: Back from full screen to the guide (Live TV); scrolling down a row at
// a time, then a page at a time with the channel keys; moving along the
// time line; a channel by number; changing group; searching; OK to watch
// full screen and Back to the guide; the Guide key from full screen and Back.
//
// Input, all optional:
//   "rows": 60          rows scrolled one at a time
//   "everyMs": 100      between those presses (10 a second, as a held key)
//   "pages": 10         pages scrolled with the channel key
//   "pageEveryMs": 300

async function probe(input) {
  const app = window.velio;
  const { rows = 60, everyMs = 100, pages = 10, pageEveryMs = 300 } = input;
  const { player, lineup } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const KEYS = {
    up: 38,
    down: 40,
    left: 37,
    right: 39,
    enter: 13,
    back: 10009,
    channelUp: 427,
    channelDown: 428,
    guide: 458,
  };
  const press = keyCode => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
    }
  };
  const type = async text => {
    for (const digit of text) {
      press(48 + Number(digit));
      await sleep(150);
    }
  };
  const waitFor = async (test, ms = 15_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(20);
    }
    return Math.round(performance.now() - start);
  };

  // Frames: the rate each second, the longest gap, and gaps over 50 ms.
  const frames = { count: 0, since: performance.now(), fps: [], last: performance.now(), gaps: [] };
  let running = true;
  requestAnimationFrame(function count(now) {
    frames.count++;
    frames.gaps.push(now - frames.last);
    frames.last = now;
    if (now - frames.since >= 1000) {
      frames.fps.push(Math.round((frames.count * 1000) / (now - frames.since)));
      frames.count = 0;
      frames.since = now;
    }
    if (running) requestAnimationFrame(count);
  });
  const section = () => {
    const out = {
      fps: frames.fps.slice(),
      longestFrameMs: Math.round(Math.max(0, ...frames.gaps)),
      framesOver50ms: frames.gaps.filter(gap => gap > 50).length,
    };
    frames.fps = [];
    frames.gaps = [];
    return out;
  };

  const page = () => app.guidePage;
  const live = () => app.live;
  const loadingRows = () =>
    page()
      ?.rows()
      .filter(row => row?.cells[0]?.kind === "loading").length ?? -1;
  const cursorName = () => page()?.cursorChannel()?.name;
  const focusedTitle = () => {
    const cell = page()?.focusedCell();
    return cell?.programme?.title ?? cell?.kind;
  };
  const results = {};

  // From full screen: Back (once for the banner) to the guide, which takes the focus.
  // Right after the restart, the page may not be up yet.
  if ((await waitFor(() => app.live, 30_000)) === undefined) {
    return { error: "window.velio.live is missing: is the app full screen?" };
  }
  await waitFor(() => lineup.channels().length > 0 && live()?.zapper.playing(), 30_000);
  await sleep(1000);
  const backStart = performance.now();
  const startBacks = [];
  for (let i = 0; i < 5 && live()?.watching(); i++) {
    press(KEYS.back);
    await sleep(400);
    startBacks.push({
      hash: location.hash,
      banner: live()?.bannerShown(),
      pending: live()?.zapper.pending(),
    });
  }
  if ((await waitFor(() => page())) === undefined)
    return { error: "Back didn't open the guide", backs: startBacks };
  const opened = Math.round(performance.now() - backStart);
  await sleep(500);
  results.open = {
    openedMs: opened,
    channels: page()?.list().length,
    cursor: cursorName(),
    preview: page()?.previewId(),
    focused: focusedTitle(),
    loadingRows: await waitFor(() => loadingRows() === 0, 5000),
  };
  log("open", results.open);
  await sleep(1500);
  section();

  // Down a row at a time, as when holding the key.
  const startCursor = page().cursor();
  for (let i = 0; i < rows; i++) {
    press(KEYS.down);
    await sleep(everyMs);
  }
  const scrolled = section();
  const loadingAtEnd = loadingRows();
  results.scroll = {
    rows: page().cursor() - startCursor,
    ...scrolled,
    loadingRowsAtEnd: loadingAtEnd,
    readyAfterMs: await waitFor(() => loadingRows() === 0, 5000),
  };
  log("scroll", results.scroll);
  await sleep(1500);
  section();

  // A page at a time, with the channel key.
  const pageStart = page().cursor();
  for (let i = 0; i < pages; i++) {
    press(KEYS.channelDown);
    await sleep(pageEveryMs);
  }
  const paged = section();
  results.pages = {
    rows: page().cursor() - pageStart,
    ...paged,
    loadingRowsAtEnd: loadingRows(),
    readyAfterMs: await waitFor(() => loadingRows() === 0, 5000),
  };
  log("pages", results.pages);
  await sleep(1000);

  // Along the time line, and back to the start. (The preview has switched
  // to the channel the pages ended on by now.)
  section();
  const fromBefore = page().from();
  const titles = [focusedTitle()];
  for (let i = 0; i < 8; i++) {
    press(KEYS.right);
    await sleep(250);
    titles.push(focusedTitle());
  }
  const movedHours = (page().from() - fromBefore) / 3_600_000;
  const along = section();
  let lefts = 0;
  while (page().from() > fromBefore && lefts < 30) {
    press(KEYS.left);
    lefts++;
    await sleep(150);
  }
  results.time = { titles, spanMovedHours: movedHours, leftsBack: lefts, ...along };
  log("time", results.time);

  // A channel by number.
  await type("500");
  press(KEYS.enter);
  await sleep(500);
  const at500 = page().cursorChannel();
  results.number = { typed: "500", name: at500?.name, number: at500?.number };
  log("number", results.number);

  // Up from the first row to the group line, Right to the next group.
  await type("1");
  press(KEYS.enter);
  await sleep(400);
  press(KEYS.up);
  await sleep(300);
  const areaAfterUp = page().area();
  press(KEYS.right);
  await sleep(400);
  const group = page().filter();
  press(KEYS.down);
  await sleep(300);
  results.group = {
    areaAfterUp,
    group: group.label,
    channels: group.channels.length,
    cursor: cursorName(),
    areaAfterDown: page().area(),
  };
  log("group", results.group);

  // Search, typing in the input the keyboard opens for.
  const word = lineup.channels()[Math.floor(lineup.channels().length / 3)].name.split(" ")[0];
  press(KEYS.up);
  await sleep(300);
  press(KEYS.enter);
  await sleep(500);
  const field = document.querySelector("input");
  if (field) {
    field.value = word;
    field.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 13, bubbles: true }));
  }
  await sleep(600);
  results.search = {
    keyboardOpened: !!field,
    query: page().query(),
    filter: page().filter().label,
    matches: page().list().length,
    allMatch: page()
      .list()
      .every(c => c.name.toLowerCase().includes(word.toLowerCase())),
    area: page().area(),
    cursor: cursorName(),
  };
  log("search", results.search);

  // Guide days read so far, before the page closes.
  results.reads = { ...page().days.stats };

  // OK: full screen on that channel; the preview's stream carries on.
  await sleep(1500);
  const picked = page().cursorChannel();
  const stateBefore = player.status().state;
  const states = new Set();
  const watcher = setInterval(() => states.add(player.status().state), 10);
  press(KEYS.enter);
  await waitFor(() => live()?.watching(), 3000);
  await sleep(1000);
  clearInterval(watcher);
  results.watch = {
    fullScreen: !!live()?.watching(),
    channel: live()?.zapper.playing()?.name,
    sameChannel: live()?.zapper.playing()?.id === picked?.id,
    stateBefore,
    restarted: stateBefore === "playing" && states.has("starting"),
  };
  log("watch", results.watch);

  // Back: to the guide, on the same channel. The first Back closes the
  // banner, which shows when full screen opens.
  let backs = 0;
  while (!page() && backs < 3) {
    press(KEYS.back);
    backs++;
    await sleep(600);
  }
  results.backToGuide = {
    guide: !!page(),
    presses: backs,
    cursor: cursorName(),
    sameChannel: page()?.cursorChannel()?.id === picked?.id,
    focused: focusedTitle(),
  };
  log("back to guide", results.backToGuide);

  // OK again, then the Guide key, then Back: full screen on the same channel.
  press(KEYS.enter);
  await waitFor(() => live()?.watching(), 3000);
  await sleep(800);
  const watched = live()?.zapper.playing()?.id;
  press(KEYS.guide);
  const guideOpened = await waitFor(() => page(), 3000);
  await sleep(600);
  press(KEYS.back);
  await waitFor(() => live()?.watching(), 3000);
  await sleep(500);
  results.guideKey = {
    guideOpened: guideOpened !== undefined,
    backFullScreen: !!live()?.watching(),
    sameChannel: live()?.zapper.playing()?.id === watched,
  };
  log("guide key", results.guideKey);

  running = false;
  results.freeMemoryMb = Math.round(tizen.systeminfo.getAvailableMemory() / 1048576);
  return results;
}
