// Phase 7, step 3: the small window's picture going behind the main one, or
// see-through, after a zap (the user saw it sometimes). Samsung's docs have
// no way to say which player draws on top. With the small window open, the
// main channel zaps a few times with each of these, and a label at the
// bottom left says which zap is on; the user watches and notes the labels
// where the small picture was missing:
//   1 "none"     nothing done after the zap
//   2 "rect"     the small player's window set again once the main one plays
//   3 "reopen"   the small player opened again once the main one plays
//   4 "mainflag" the main player opened with IN_APP_MULTIVIEW set to
//                VIDEO_VIEW_RESOURCE_MAIN (the docs' example leaves it out)
// and, with "only":
//   "closefirst", "closefirst 1000 ms"  the small player closed before the
//                zap, and opened again once the main one plays (or 1 s later)
//   "stopmain"   the main player stopped instead of closed, and reused
// About 1 minute 45 s.
//
// Input, all optional:
//   "zaps": 4         zaps for each
//   "seconds": 6      time on each zap
//   "only": ["rect"]  only these
//   "delays": [1000]  also reopen this long after the main one plays, for
//                     each ("reopen 1000 ms" for "only")

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
  const RECT = { x: 1920 - 640 - 60, y: 60, width: 640, height: 360 };

  // A label over the app's canvas.
  const label = document.createElement("div");
  label.style.cssText =
    "position:fixed;left:40px;bottom:40px;z-index:99999;padding:12px 24px;background:#000c;color:#fff;font:bold 44px sans-serif";
  document.body.appendChild(label);
  const say = text => {
    label.textContent = text;
  };

  await waitFor(() => lineup.channels().length > 0, 30_000);
  const find = path =>
    lineup
      .channels()
      .find(channel => channel.url.includes(path) && !channel.url.includes("/fail/") && !channel.catchup);
  const small = find("/hls/h264-aac/");
  const mains = [find("/ts/h264-mp2."), find("/ts/hevc-aac.")];
  if (!small || mains.some(one => !one)) return { error: "No test-server channels" };

  location.hash = "#/watch";
  await waitFor(() => live()?.zapper, 5000);
  live().zapper.tune(mains[1], live().zapper.group());
  await waitFor(() => player.status().state === "playing");
  live()
    .smallOptions(small)
    .find(option => option.id === "smallOpen")
    ?.run();
  await waitFor(() => secondPlayer.status().state === "playing");
  say("Small window open");
  await sleep(3000);

  // For "mainflag": the main player's AVPlay sets the property after each open.
  const av = webapis.avplay;
  const originalOpen = av.open;
  let patched = false;
  const patchMain = () => {
    try {
      av.open = function (url) {
        originalOpen.call(av, url);
        av.setStreamingProperty("IN_APP_MULTIVIEW", "VIDEO_VIEW_RESOURCE_MAIN");
      };
      patched = av.open !== originalOpen;
    } catch (caught) {
      log("patch failed", String(caught));
    }
  };
  // For "stopmain": the main player's AVPlay is stopped instead of closed,
  // and opens the next stream from there (open() is allowed when IDLE).
  const originalClose = av.close;
  const keepMain = () => {
    try {
      av.close = function () {
        av.stop();
      };
      patched = av.close !== originalClose;
    } catch (caught) {
      log("patch failed", String(caught));
    }
  };
  const unpatchMain = () => {
    try {
      av.open = originalOpen;
      av.close = originalClose;
    } catch {
      // Left as it was.
    }
  };
  // For "closefirst": the small player closes before the zap.
  let smallStream;
  const closeSmall = () => {
    smallStream = secondPlayer.status().stream ?? smallStream;
    secondPlayer.stop();
  };
  const openSmall = async ms => {
    await sleep(ms);
    secondPlayer.setWindow(RECT);
    await secondPlayer.play(smallStream);
  };

  const reopen = async ms => {
    await sleep(ms);
    const stream = secondPlayer.status().stream;
    secondPlayer.stop();
    secondPlayer.setWindow(RECT);
    await secondPlayer.play(stream);
  };
  // [name, after the main one plays, before the zap, at the start, at the end]
  const none = () => undefined;
  const variants = [
    ["none", none],
    ["rect", () => secondPlayer.setWindow(RECT)],
    ["reopen", () => reopen(0)],
    ["mainflag", none, none, patchMain, unpatchMain],
    // Reopening a while after the main one plays.
    ...(input.delays ?? []).map(ms => [`reopen ${ms} ms`, () => reopen(ms)]),
    ["closefirst", () => openSmall(0), closeSmall],
    ["closefirst 1000 ms", () => openSmall(1000), closeSmall],
    ["stopmain", none, none, keepMain, unpatchMain],
  ].filter(([name]) => !input.only || input.only.includes(name));

  const results = [];
  let zap = 0;
  for (const [index, [name, after, before = none, setUp = none, tearDown = none]] of variants.entries()) {
    patched = false;
    setUp();
    const count = input.zaps ?? 4;
    for (let i = 1; i <= count; i++) {
      const channel = mains[zap++ % 2];
      const text = `${index + 1} · ${String(name)} · zap ${i}/${count}`;
      say(`${text} …`);
      before();
      live().zapper.tune(channel, live().zapper.group());
      const ms = await waitFor(
        () => live().zapper.playing()?.id === channel.id && player.status().state === "playing",
      );
      await after();
      say(text);
      const was = secondPlayer.position();
      await sleep((input.seconds ?? 6) * 1000);
      const row = {
        label: text,
        mainMs: ms,
        smallMoves: secondPlayer.position() - was > 2000,
        smallState: secondPlayer.status().state,
        ...(setUp === none ? {} : { patched }),
        ...(player.status().error ? { mainError: player.status().error } : {}),
      };
      results.push(row);
      log(text, row);
    }
    tearDown();
  }
  say("Done");
  await sleep(2000);
  label.remove();
  live()
    .smallOptions(live().zapper.playing())
    .find(option => option.id === "smallClose")
    ?.run();
  return { results };
}
