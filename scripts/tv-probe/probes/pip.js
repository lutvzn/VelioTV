// Phase 7, step 1: a second, small player beside the app's own (Phase 0,
// test 5 used two players from webapis.avplaystore; the app's player is
// webapis.avplay). The app's player plays full screen on the developer
// video page; a second one from the store plays in a corner on the sub
// video scaler, without sound. About 40 s.
//
// Checks, each over 3 s: both play; the app's player changes stream (a zap)
// while the small one plays; the two swap streams; the small one closes
// and the main one plays on; and the small one opens again after that.
// Look at the TV meanwhile: the small one is at the top right.
//
// Input:
//   "server": "http://<dev-ip>:8090"   the test server (required)
//   "hold": 0                          seconds to hold at the end, to look

async function probe(input) {
  const app = window.tiviplayer;
  if (!app?.player) return { error: "window.tiviplayer.player is missing" };
  if (!input.server) return { error: 'Give the test server\'s address as "server"' };
  if (typeof webapis === "undefined" || !webapis.avplaystore) return { error: "No webapis.avplaystore" };
  const { player } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const waitFor = async (test, ms = 20_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(50);
    }
    return Math.round(performance.now() - start);
  };
  const ts = id => `${input.server}/ts/${id}.ts`;
  const hls = id => `${input.server}/hls/${id}/index.m3u8`;
  const RECT = { x: 1920 - 640 - 60, y: 60, width: 640, height: 360 };

  // The small player.
  let small;
  let element;
  const closeSmall = () => {
    try {
      small?.close();
    } catch {
      // Closed already.
    }
    element?.remove();
    small = undefined;
  };
  const openSmall = async url => {
    closeSmall();
    element = document.createElement("object");
    element.type = "application/avplayer";
    element.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px";
    document.body.appendChild(element);
    const started = performance.now();
    small = webapis.avplaystore.getPlayer();
    small.open(url);
    small.setBufferingParam("PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_SIZE_IN_SECOND", 2);
    small.setDisplayRect(RECT.x, RECT.y, RECT.width, RECT.height);
    let shown;
    const picture = new Promise(resolve => (shown = resolve));
    small.setListener({
      onbufferingcomplete: () => shown(),
      onerror: error => log("small error", String(error)),
    });
    small.disableAudioStream();
    small.setStreamingProperty("IN_APP_MULTIVIEW", "VIDEO_VIEW_RESOURCE_SUB");
    await new Promise((resolve, reject) => small.prepareAsync(resolve, reject));
    small.play();
    await Promise.race([picture, sleep(15_000).then(() => Promise.reject(new Error("no picture in 15 s")))]);
    return Math.round(performance.now() - started);
  };
  // Whether each moves on over 3 s.
  const bothPlay = async () => {
    const main0 = player.position();
    const small0 = small ? small.getCurrentTime() : 0;
    await sleep(3000);
    return {
      main: player.status().state === "playing" && player.position() - main0 > 2000,
      small: small ? small.getCurrentTime() - small0 > 2000 : undefined,
      mainState: player.status().state,
      smallState: small?.getState(),
    };
  };

  const result = {};
  const step = async (name, run) => {
    try {
      const ms = await run();
      result[name] = { ms, ...(await bothPlay()) };
    } catch (error) {
      result[name] = { error: `${error?.name ?? ""}: ${error?.message ?? error}`, ...(await bothPlay()) };
    }
    log(name, result[name]);
  };

  location.hash = "#/dev/video";
  await sleep(1000);
  void player.play({ url: ts("h264-aac"), live: true });
  if ((await waitFor(() => player.status().state === "playing")) === undefined) {
    return { error: `The main stream didn't play: ${player.status().state}` };
  }
  await step("smallOpens", () => openSmall(hls("hevc-aac")));
  await step("mainZaps", async () => {
    const started = performance.now();
    void player.play({ url: ts("h264-ac3"), live: true });
    await waitFor(() => player.status().state === "playing");
    return Math.round(performance.now() - started);
  });
  await step("swap", async () => {
    const started = performance.now();
    closeSmall();
    void player.play({ url: hls("hevc-aac"), live: true });
    await waitFor(() => player.status().state === "playing");
    await openSmall(ts("h264-ac3"));
    return Math.round(performance.now() - started);
  });
  await step("smallCloses", async () => {
    closeSmall();
    return 0;
  });
  await step("smallOpensAgain", () => openSmall(hls("h264-aac")));
  await sleep((input.hold ?? 0) * 1000);
  closeSmall();
  player.stop();
  location.hash = "#/";
  return result;
}
