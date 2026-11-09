// Phase 5, steps 3 and 5: hiding channels and groups, moving a channel into
// a custom group, the group options, and the parental PIN. It needs a source
// with channels (see the `sources` probe) and starts from the app's start,
// full screen. It takes about 40 s, and puts the edits and settings back as
// it found them.
//
// In order, with the remote's keys unless said:
// - full screen: holding OK, then Hide, hides the channel playing: it leaves
//   the view and number entry, and the lineup keeps it;
// - holding OK, Move to group, then a custom group the probe made, moves the
//   next channel there;
// - the guide, on that group's line: holding OK opens the group's options;
//   Move group down keeps the panel open, and Order, then By name, sorts it;
// - with a PIN set and entered no more, Lock on the group locks its channel:
//   the preview doesn't play it and its row shows no programmes; OK asks for
//   the PIN, a wrong one is refused, the right one plays it full screen;
// - full screen, locked again: tuning to it plays nothing until OK and the PIN;
// - the guide again: Hide group from its options hides it, and the guide goes
//   back to every channel.
//
// Input, all optional:
//   "holdMs": 900   how long OK is held

async function probe(input) {
  const app = window.velio;
  if (!app?.settings?.setPin) return { error: "this build has no PIN: deploy the app first" };
  const { holdMs = 900 } = input;
  const { lineup, edits, settings, liveView } = app;
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
  const type = async digits => {
    for (const digit of digits) await press(48 + Number(digit), 150);
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
  const panel = () => app.channelOptions;
  // Moves the panel's cursor to an option and presses OK on it.
  const choose = async id => {
    const at = panel()?.options().indexOf(id) ?? -1;
    if (at < 0) return false;
    while (panel().cursor() < at) await press(KEYS.down, 120);
    await press(KEYS.enter);
    return true;
  };
  // Back from full screen: the first may only hide the banner.
  const toGuide = async () => {
    for (let i = 0; i < 3 && !page(); i++) await press(KEYS.back, 1200);
    await waitFor(() => page()?.list().length > 0);
  };
  // Back to the groups' column, then down it to a group.
  const toGroupLine = async key => {
    if (page().area() !== "filters") await press(KEYS.back);
    for (let i = 0; i < 40 && page().filter().group !== key; i++) await press(KEYS.down);
  };
  const PIN = "1379";
  const results = {};

  await waitFor(() => lineup.channels().length > 0 && live()?.zapper.playing(), 30_000);
  await sleep(1000);
  const savedEdits = JSON.parse(JSON.stringify(edits.all()));
  const savedSettings = JSON.parse(JSON.stringify(settings.all()));

  try {
    // Hide the channel playing.
    const zapper = live().zapper;
    const hidden = zapper.playing();
    const number = zapper.numberOf(hidden);
    await hold(KEYS.enter);
    const offered = panel()?.options();
    const chose = await choose("hide");
    await sleep(300);
    results.hide = {
      offered,
      chose,
      hidden: edits.isChannelHidden(hidden.id),
      outOfView: !liveView().channels.some(channel => channel.id === hidden.id),
      inLineup: !!lineup.find(hidden.id),
      numberGone: !app.live.zapper.groupChannels(undefined).some(channel => channel.id === hidden.id),
      numberKept: number,
    };
    log("hide", results.hide);
    edits.setChannelHidden(hidden.id, false);

    // Move the next channel into a custom group.
    await press(KEYS.up, 1500);
    const moving = zapper.playing();
    const key = edits.createGroup("Probe group");
    await hold(KEYS.enter);
    await choose("moveTo");
    const menu = { title: panel()?.title(), depth: panel()?.depth(), first: panel()?.options()[0] };
    const picked = await choose(`group:${key}`);
    await sleep(300);
    results.moveTo = {
      menu,
      picked,
      closed: !panel(),
      inGroup: liveView().groupOf(moving) === key,
      groupShown: liveView().groups.some(group => group.name === key),
    };
    log("moveTo", results.moveTo);

    // The group first, then the guide on its line.
    edits.setGroupOrder([key]);
    await toGuide();
    await toGroupLine(key);
    const onLine = page().area() === "filters" && page().filter().group === key;
    await hold(KEYS.enter);
    const groupOffered = panel()?.options();
    const forGroup = page().groupOptionsFor();
    await choose("moveDown");
    const stayedOpen = !!panel();
    const movedDown = liveView()
      .groups.map(group => group.name)
      .indexOf(key);
    await choose("sort");
    const sortMenu = { title: panel()?.title(), options: panel()?.options() };
    await choose("sort:name");
    await sleep(300);
    results.groupOptions = {
      onLine,
      forGroup: forGroup === key,
      offered: groupOffered,
      stayedOpen,
      movedDownTo: movedDown,
      sortMenu,
      sorted: edits.sortOf(key),
      closed: !panel(),
    };
    log("groupOptions", results.groupOptions);

    // Lock the group, with a PIN that isn't entered yet.
    settings.setPin(PIN);
    settings.lock();
    await hold(KEYS.enter);
    await choose("lock");
    await sleep(300);
    const lockedGroup = edits.isGroupLocked(key);
    await press(KEYS.down, 1500);
    const row = page().rows()[page().cursor() - page().top()];
    results.lockedInGuide = {
      lockedGroup,
      cursorOn: page().cursorChannel()?.id === moving.id,
      notPreviewed: page().previewId() === undefined,
      playerIdle: app.player.status().state === "idle",
      rowLocked: row?.cells[0]?.kind === "locked",
    };
    await press(KEYS.enter, 600);
    const prompt = !!app.pinPrompt;
    await type("0000");
    const refused = app.pinPrompt?.wrong();
    await type(PIN);
    await waitFor(() => live()?.zapper.playing()?.id === moving.id, 5000);
    results.lockedInGuide = {
      ...results.lockedInGuide,
      prompt,
      refused,
      promptClosed: !app.pinPrompt,
      unlocked: settings.unlocked(),
      watching: live()?.zapper.playing()?.id === moving.id,
    };
    log("lockedInGuide", results.lockedInGuide);

    // Full screen, locked again: tuning to it waits for the PIN.
    await sleep(1500);
    settings.lock();
    const other = lineup
      .channels()
      .find(channel => channel.id !== moving.id && !edits.isChannelHidden(channel.id));
    live().zapper.tune(other);
    await sleep(1500);
    live().zapper.tune(moving, key);
    await sleep(800);
    const waiting = live().lockedChannel()?.id === moving.id;
    const idle = app.player.status().state === "idle";
    await press(KEYS.enter, 600);
    const asked = !!app.pinPrompt;
    await type(PIN);
    await sleep(1500);
    results.lockedFullScreen = {
      waiting,
      idle,
      asked,
      plays: !live().lockedChannel() && app.player.status().state !== "idle",
    };
    log("lockedFullScreen", results.lockedFullScreen);

    // Hide the group from the guide's group line.
    await toGuide();
    await toGroupLine(key);
    await hold(KEYS.enter);
    await choose("hideGroup");
    await sleep(500);
    results.hideGroup = {
      hidden: edits.isGroupHidden(key),
      filter: page().filter().id,
      gone: !liveView().groups.some(group => group.name === key),
      channelGone: !liveView().channels.some(channel => channel.id === moving.id),
    };
    log("hideGroup", results.hideGroup);
  } finally {
    edits.replace(savedEdits);
    settings.replace(savedSettings);
    results.restored = JSON.stringify(edits.all()) === JSON.stringify(savedEdits);
  }
  return results;
}
