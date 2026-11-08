// Phase 5, step 1: channel ids that outlast a new import, and the channel
// options. It needs a source with channels (see the `sources` probe) and
// starts from the app's start, full screen. It takes about 30 s, and leaves
// the favourites as it found them.
//
// In order: the ids (all unique, how each was keyed, how long keying the
// whole lineup takes, and whether they match the last run's); holding OK in
// full screen opens the playing channel's options, and OK there makes it a
// favourite; a quick OK shows or hides the channel's card, and Left opens
// the channel list; Back to the guide,
// where the Tools key opens the highlighted channel's options and Back
// closes them; holding OK there and OK removes the favourite again.
//
// Input, all optional:
//   "holdMs": 900   how long OK is held

async function probe(input) {
  const app = window.velio;
  if (!app?.edits || !app?.channelKeys)
    return { error: "window.velio.edits is missing: deploy the app first" };
  const { holdMs = 900 } = input;
  const { lineup, edits } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const KEYS = { left: 37, down: 40, enter: 13, back: 10009, tools: 10135 };
  const send = (type, keyCode) => document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
  const press = keyCode => {
    send("keydown", keyCode);
    send("keyup", keyCode);
  };
  // As a Samsung remote does when OK is held: one key-down, and one key-up
  // when it's let go, with no repeats between (see the `keys` probe).
  const hold = async keyCode => {
    send("keydown", keyCode);
    await sleep(holdMs);
    send("keyup", keyCode);
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
  const results = {};

  await waitFor(() => lineup.channels().length > 0 && live()?.zapper.playing(), 30_000);
  await sleep(1000);

  // Ids.
  const channels = lineup.channels();
  const ids = channels.map(channel => channel.id);
  const kinds = {};
  for (const id of ids) {
    const kind = id.slice(id.indexOf("/") + 1).split(":")[0];
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  const keyed = performance.now();
  for (const source of new Set(channels.map(channel => channel.source))) {
    app.channelKeys(channels.filter(channel => channel.source === source));
  }
  const sample = ids.filter((_, index) => index % 97 === 0).join("\n");
  const previous = localStorage.getItem("probe.channelIds");
  localStorage.setItem("probe.channelIds", sample);
  results.ids = {
    channels: ids.length,
    unique: new Set(ids).size === ids.length,
    kinds,
    shared: ids.filter(id => id.includes("|")).length,
    keyingMs: Math.round(performance.now() - keyed),
    sameAsLastRun: previous === null ? "first run" : previous === sample,
    examples: ids.slice(0, 3),
  };
  log("ids", results.ids);

  // Full screen: hold OK, then OK on "Add to favourites".
  const playing = live().zapper.playing();
  const wasFavourite = edits.isFavourite(playing.id);
  await hold(KEYS.enter);
  await sleep(300);
  const opened = { for: live().optionsFor()?.id, options: options()?.options(), listOpen: live().listOpen() };
  press(KEYS.enter);
  await sleep(300);
  results.fullScreen = {
    opened: opened.for === playing.id,
    options: opened.options,
    listOpenedToo: opened.listOpen,
    closed: !live().optionsFor(),
    favourite: edits.isFavourite(playing.id),
    favouriteBefore: wasFavourite,
    stored: JSON.parse(localStorage.getItem("velio.channelEdits") ?? "{}").favourites?.includes(playing.id),
  };
  log("full screen", results.fullScreen);

  // A quick OK shows the channel's card, and again hides it; Left opens the
  // list, and Back closes it.
  const cardBefore = live().bannerShown();
  press(KEYS.enter);
  await sleep(300);
  results.tap = { card: live().bannerShown() !== cardBefore, options: !!live().optionsFor() };
  press(KEYS.enter);
  await sleep(300);
  results.tap.cardBack = live().bannerShown() === cardBefore;
  press(KEYS.left);
  await sleep(300);
  results.tap.listOpen = live().listOpen();
  press(KEYS.back);
  await sleep(300);
  results.tap.listClosed = !live().listOpen();
  log("tap", results.tap);

  // To the guide: Tools opens the options, Back closes them, and the guide has the keys again.
  for (let i = 0; i < 4 && live()?.watching(); i++) {
    press(KEYS.back);
    await sleep(400);
  }
  await waitFor(() => page(), 3000);
  await sleep(500);
  const cursorBefore = page().cursor();
  press(KEYS.tools);
  await sleep(300);
  const toolsFor = page().optionsFor()?.id;
  press(KEYS.down);
  await sleep(200);
  const cursorWhileOpen = page().cursor();
  press(KEYS.back);
  await sleep(300);
  press(KEYS.down);
  await sleep(300);
  results.guideTools = {
    opened: toolsFor === page().list()[cursorBefore]?.id,
    keysStayedInPanel: cursorWhileOpen === cursorBefore,
    closed: !page().optionsFor(),
    downMovesAfter: page().cursor() === cursorBefore + 1,
  };
  log("guide tools", results.guideTools);

  // Back up to the channel, hold OK, OK: no longer a favourite.
  page().list();
  const target = page().list()[cursorBefore];
  // Up a row, back on the channel that was made a favourite.
  document.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 38, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keyup", { keyCode: 38, bubbles: true }));
  await sleep(300);
  const onTarget = page().cursorChannel()?.id === target?.id;
  await hold(KEYS.enter);
  await sleep(300);
  const heldFor = page().optionsFor()?.id;
  press(KEYS.enter);
  await sleep(300);
  results.guideHold = {
    onTarget,
    opened: heldFor === target?.id,
    stillInGuide: !!page(),
    favourite: edits.isFavourite(target?.id),
  };
  log("guide hold", results.guideHold);

  // Leave the favourites as they were.
  edits.setFavourite(playing.id, wasFavourite);
  results.restored = edits.isFavourite(playing.id) === wasFavourite;
  return results;
}
