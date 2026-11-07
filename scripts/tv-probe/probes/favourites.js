// Phase 5, step 2: the Favourites group. It needs a source with channels
// (see the `sources` probe) and starts from the app's start, full screen. It
// takes about 30 s, and puts the favourites back as it found them.
//
// In order: three channels made favourites; the full-screen list's next
// group after All channels is Favourites, OK there plays its first, and
// zapping goes round the three; Back to the guide, which opens on
// Favourites; holding OK on the third, then Move and Up twice, puts it
// first; removing one from its options leaves two.
//
// Input, all optional:
//   "holdMs": 900   how long OK is held

async function probe(input) {
  const app = window.tiviplayer;
  if (!app?.edits?.moveFavourite) return { error: "this build has no Favourites: deploy the app first" };
  const { holdMs = 900 } = input;
  const { lineup, edits } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const KEYS = { up: 38, down: 40, left: 37, right: 39, enter: 13, back: 10009 };
  const send = (type, keyCode) => document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
  const press = async (keyCode, wait = 300) => {
    send("keydown", keyCode);
    send("keyup", keyCode);
    await sleep(wait);
  };
  const hold = async keyCode => {
    send("keydown", keyCode);
    await sleep(holdMs);
    send("keyup", keyCode);
    await sleep(300);
  };
  const waitFor = async (test, ms = 15_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(20);
    }
    return Math.round(performance.now() - start);
  };
  const live = () => app.live;
  const page = () => app.guidePage;
  const options = () => app.channelOptions;
  const names = list => list.map(channel => channel.name);
  const results = {};

  await waitFor(() => lineup.channels().length > 0 && live()?.zapper.playing(), 30_000);
  await sleep(1000);

  // Three favourites, in this order.
  const before = edits.favourites().slice();
  for (const id of before) edits.setFavourite(id, false);
  const all = lineup.channels();
  const picked = [all[10], all[20], all[30]];
  for (const channel of picked) edits.setFavourite(channel.id, true);
  await sleep(200);

  try {
    // Full screen: OK opens the list, Right goes to Favourites, OK plays its first.
    await press(KEYS.enter);
    await press(KEYS.right);
    await press(KEYS.enter, 1500);
    const zapper = live().zapper;
    const zapped = [zapper.playing()?.name];
    for (let i = 0; i < 3; i++) {
      await press(KEYS.up, 100);
      zapped.push(zapper.shown()?.name);
    }
    await sleep(1500);
    results.fullScreen = {
      group: zapper.group() === "\u0000favourites" ? "Favourites" : zapper.group(),
      first: zapper.playing()?.name === picked[0].name,
      zapped,
      goesRound: zapped.join() === names([...picked, picked[0]]).join(),
    };
    log("full screen", results.fullScreen);

    // Back to the guide, on Favourites.
    for (let i = 0; i < 4 && live()?.watching(); i++) await press(KEYS.back, 400);
    await waitFor(() => page(), 3000);
    await sleep(500);
    results.guide = {
      filter: page().filter().label,
      list: names(page().list()),
      cursor: page().cursorChannel()?.name,
    };
    log("guide", results.guide);

    // Down to the third, hold OK, Down to Move, OK, Up twice, OK.
    while (page().cursor() < 2) await press(KEYS.down);
    await hold(KEYS.enter);
    const offered = options()?.options();
    await press(KEYS.down);
    await press(KEYS.enter);
    const moving = page().moving()?.name;
    await press(KEYS.up);
    await press(KEYS.up);
    const whileMoving = { cursor: page().cursorChannel()?.name, list: names(page().list()) };
    await press(KEYS.enter);
    results.move = {
      offered,
      moving,
      whileMoving,
      ended: !page().moving(),
      order: names(page().list()),
      stored: edits.favourites().map(id => lineup.find(id)?.name),
      cursorStaysOnIt: page().cursorChannel()?.name === picked[2].name,
    };
    log("move", results.move);

    // Hold OK on the next one and remove it from Favourites.
    await press(KEYS.down);
    const removing = page().cursorChannel()?.name;
    await hold(KEYS.enter);
    await press(KEYS.enter);
    results.remove = { removed: removing, left: names(page().list()), filter: page().filter().label };
    log("remove", results.remove);
  } finally {
    for (const id of edits.favourites().slice()) edits.setFavourite(id, false);
    for (const id of before) edits.setFavourite(id, true);
    results.restored = edits.favourites().join() === before.join();
  }
  return results;
}
