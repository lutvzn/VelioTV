// Phase 7, step 3: a second channel in a small window on the live page
// (src/pages/Watch.tsx), through its options, with the remote's keys. It
// needs the test server's sources (the `sources` probe). About 50 s.
//
// 1. OK opens the list; Down, then holding OK on another channel and
//    choosing "Watch in a small window" plays it in the top right corner,
//    without sound, and the list closes. Both play.
// 2. Channel up zaps the main channel; the small one plays on.
// 3. Swap, from the playing channel's options: the two change places.
// 4. Move: to the next corner, clockwise; the options stay open.
// 5. Close: the small one stops; the main one plays on.
// 6. It opens again, and leaving the live page closes it.
// Look at the TV meanwhile: the window's frame should sit on its picture.
//
// Input, all optional:
//   "hold": 900    how long OK is held, in ms
//   "look": 0      seconds to wait after each step, to look at the TV

async function probe(input) {
  const app = window.tiviplayer;
  if (!app?.secondPlayer) return { error: "window.tiviplayer.secondPlayer is missing: deploy the app first" };
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
  const send = (type, keyCode) => document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
  const press = keyCode => {
    send("keydown", keyCode);
    send("keyup", keyCode);
  };
  const hold = async keyCode => {
    send("keydown", keyCode);
    await sleep(input.hold ?? 900);
    send("keyup", keyCode);
    await sleep(300);
  };
  const KEY = { up: 38, down: 40, enter: 13, back: 10009, channelUp: 427 };
  const live = () => app.live;
  const options = () => app.channelOptions;
  const look = () => sleep((input.look ?? 0) * 1000);
  const good = channel => channel && /\/(ts|hls)\//.test(channel.url);
  // Whether both move on over 3 s.
  const bothPlay = async () => {
    const main = player.position();
    const small = secondPlayer.position();
    await sleep(3000);
    return {
      main: player.status().state === "playing" && player.position() - main > 2000,
      small: secondPlayer.status().state === "playing" && secondPlayer.position() - small > 2000,
    };
  };
  // Picks an option in the open options menu, with Down and OK.
  const choose = async id => {
    const at = options()?.options().indexOf(id) ?? -1;
    if (at < 0) return false;
    for (let i = options().cursor(); i < at; i++) {
      press(KEY.down);
      await sleep(150);
    }
    press(KEY.enter);
    await sleep(300);
    return true;
  };

  await waitFor(() => lineup.channels().length > 0, 30_000);
  const first = lineup.channels().find(channel => channel.url.includes("/ts/h264-aac"));
  if (!first) return { error: "No test-server channel to start on" };
  location.hash = "#/watch";
  await waitFor(() => live()?.zapper, 5000);
  live().zapper.tune(first, live().zapper.group());
  await waitFor(() => player.status().state === "playing" && live().watching());
  await sleep(800);
  if (live().bannerShown()) press(KEY.back);
  await sleep(300);
  const result = {};

  // 1. From the list.
  {
    const step = {};
    result.open = step;
    press(KEY.enter);
    await sleep(400);
    step.listOpen = live().listOpen();
    for (let i = 0; i < 10; i++) {
      press(KEY.down);
      await sleep(200);
      // Three on at least, so Channel up in step 2 doesn't land on it.
      if (i >= 2 && good(live().listChannel()) && live().listChannel().id !== first.id) break;
    }
    const picked = live().listChannel();
    await hold(KEY.enter);
    step.options = options()?.options();
    const started = performance.now();
    step.chosen = await choose("smallOpen");
    step.listClosed = !live().listOpen();
    step.small = live().smallChannel()?.name === picked?.name ? picked.name : live().smallChannel()?.name;
    step.ms = await waitFor(() => secondPlayer.status().state === "playing");
    step.ms = step.ms === undefined ? undefined : Math.round(performance.now() - started);
    step.corner = live().corner();
    Object.assign(step, await bothPlay());
    log("open", step);
    await look();
  }

  // 2. A zap.
  {
    const step = { from: live().zapper.playing()?.name };
    result.zap = step;
    press(KEY.channelUp);
    await waitFor(() => live().zapper.playing()?.name !== step.from, 3000);
    step.to = live().zapper.playing()?.name;
    step.ms = await waitFor(() => player.status().state === "playing");
    step.smallStill = live().smallChannel()?.name;
    step.notTheSame = step.smallStill !== step.to;
    Object.assign(step, await bothPlay());
    log("zap", step);
    await look();
  }

  // 3. Swap.
  {
    const main = live().zapper.playing();
    const small = live().smallChannel();
    const step = {};
    result.swap = step;
    if (live().bannerShown()) press(KEY.back);
    await sleep(300);
    await hold(KEY.enter);
    step.options = options()?.options();
    const started = performance.now();
    step.chosen = await choose("smallSwap");
    await waitFor(
      () =>
        live().zapper.playing()?.id === small?.id &&
        player.status().state === "playing" &&
        secondPlayer.status().state === "playing",
    );
    step.ms = Math.round(performance.now() - started);
    step.swapped = live().zapper.playing()?.id === small?.id && live().smallChannel()?.id === main?.id;
    Object.assign(step, await bothPlay());
    log("swap", step);
    await look();
  }

  // 4. Move, twice, and back to the first corner with two more.
  {
    const step = { corners: [live().corner()] };
    result.move = step;
    if (live().bannerShown()) press(KEY.back);
    await sleep(300);
    await hold(KEY.enter);
    step.chosen = await choose("smallMove");
    step.corners.push(live().corner());
    step.optionsStayed = Boolean(options());
    await look();
    for (let i = 0; i < 3; i++) {
      press(KEY.enter);
      await sleep(300);
      step.corners.push(live().corner());
    }
    press(KEY.back);
    await sleep(300);
    step.optionsClosed = !options();
    Object.assign(step, await bothPlay());
    log("move", step);
  }

  // 5. Close.
  {
    const step = {};
    result.close = step;
    if (live().bannerShown()) press(KEY.back);
    await sleep(300);
    await hold(KEY.enter);
    step.chosen = await choose("smallClose");
    step.gone = live().smallChannel() === undefined;
    step.smallState = secondPlayer.status().state;
    await sleep(3000);
    step.mainPlays = player.status().state === "playing";
    log("close", step);
  }

  // 5b. Zapping to the small window's channel closes it.
  {
    const step = {};
    result.zapToSmall = step;
    const other = lineup
      .channels()
      .find(channel => good(channel) && channel.id !== live().zapper.playing()?.id);
    live()
      .smallOptions(other)
      .find(option => option.id === "smallOpen")
      ?.run();
    await waitFor(() => secondPlayer.status().state === "playing");
    live().zapper.tune(other, live().zapper.group());
    step.closed = (await waitFor(() => live().smallChannel() === undefined, 3000)) !== undefined;
    step.mainOn = live().zapper.playing()?.name === other.name;
    await waitFor(() => player.status().state === "playing");
    log("zapToSmall", step);
  }

  // 6. Again, then off the live page.
  {
    const step = {};
    result.leave = step;
    const other = lineup
      .channels()
      .find(channel => good(channel) && channel.id !== live().zapper.playing()?.id);
    live()
      .smallOptions(other)
      .find(option => option.id === "smallOpen")
      ?.run();
    step.ms = await waitFor(() => secondPlayer.status().state === "playing");
    for (let i = 0; i < 4 && live()?.watching(); i++) {
      press(KEY.back);
      await sleep(400);
    }
    step.leftLive = !live()?.watching();
    await sleep(500);
    step.smallState = secondPlayer.status().state;
    step.mainPlays = player.status().state === "playing";
    log("leave", step);
  }
  return result;
}
