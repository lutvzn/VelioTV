// Phase 0 test 5: how many streams can play at once. Adds players one at a
// time in a grid, using Samsung's avplaystore, until one fails to start or
// stops a running one. All of them then keep playing for a while so you can
// check them on the TV.
//
// Input:
//   "index": "http://<test-stream-server>/"   uses its HLS streams in turn, or
//   "urls": ["...", ...]                      used in turn
//   "max": 4            players to try (default 4; up to 9)
//   "streams": ["hevc-aac"]  with "index", only these stream ids
//   "holdSeconds": 20   how long to keep them all playing at the end
//
// Following Samsung's AVPlay docs (Tizen 7+), the first player uses the main
// video scaler and every later one asks for the sub scaler with
// IN_APP_MULTIVIEW, with its audio off.

async function probe(input) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log("[probe]", ...args);

  let urls = input.urls;
  if (input.index) {
    const index = await (await fetch(input.index)).json();
    urls = index.streams.filter(s => !input.streams || input.streams.includes(s.id)).map(s => s.hls);
  }
  const max = Math.min(input.max ?? 4, 9);
  const columns = max <= 4 ? 2 : 3;
  const cell = { width: 1920 / columns, height: 1080 / columns };

  const canvas = document.querySelector("canvas");
  if (canvas) canvas.style.visibility = "hidden";

  const players = [];
  const close = entry => {
    for (const step of [() => entry.player.stop(), () => entry.player.close()]) {
      try {
        step();
      } catch {
        // Already stopped or closed.
      }
    }
    entry.element.remove();
  };
  // Whether every running player's time moves on over three seconds.
  const allAdvancing = async () => {
    const before = players.map(entry => entry.player.getCurrentTime());
    await sleep(3000);
    lastDeltas = players.map((entry, i) => entry.player.getCurrentTime() - before[i]);
    return lastDeltas.map(delta => delta > 2000);
  };
  let lastDeltas = [];

  const results = [];
  for (let i = 0; i < max; i++) {
    const url = urls[i % urls.length];
    const result = { player: i + 1, url };
    const element = document.createElement("object");
    element.type = "application/avplayer";
    document.body.appendChild(element);
    const entry = { element, player: undefined };
    try {
      entry.player = webapis.avplaystore.getPlayer();
      const player = entry.player;
      const x = (i % columns) * cell.width;
      const y = Math.floor(i / columns) * cell.height;
      player.open(url);
      player.setBufferingParam("PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_SIZE_IN_SECOND", 2);
      player.setDisplayRect(x, y, cell.width, cell.height);
      let buffered;
      const picture = new Promise(resolve => (buffered = resolve));
      player.setListener({
        onbufferingcomplete: () => buffered(),
        onerror: error => (result.playerError = String(error)),
      });
      if (i > 0) {
        player.disableAudioStream();
        player.setStreamingProperty("IN_APP_MULTIVIEW", "VIDEO_VIEW_RESOURCE_SUB");
      }
      await new Promise((resolve, reject) => player.prepareAsync(resolve, reject));
      player.play();
      await Promise.race([
        picture,
        sleep(15000).then(() => Promise.reject(new Error("no picture within 15 s"))),
      ]);
      players.push(entry);
      // Lets playback settle after the first picture.
      await sleep(1000);
      const advancing = await allAdvancing();
      result.allPlaying = advancing.every(Boolean);
      result.playedMs = lastDeltas;
      result.states = players.map(e => e.player.getState());
      if (!result.allPlaying) result.stalled = advancing.flatMap((ok, n) => (ok ? [] : [n + 1]));
    } catch (error) {
      result.error = `${error?.name ?? ""}: ${error?.message ?? error}`;
      if (entry.player) close(entry);
      else element.remove();
    }
    log(
      `player ${i + 1}:`,
      result.error ?? (result.allPlaying ? "all playing" : `stalled ${result.stalled}`),
    );
    results.push(result);
    if (result.error || !result.allPlaying) break;
  }

  log(`holding ${players.length} players for ${input.holdSeconds ?? 20} s`);
  await sleep((input.holdSeconds ?? 20) * 1000);
  const stillPlaying = (await allAdvancing()).filter(Boolean).length;
  for (const entry of players) close(entry);
  if (canvas) canvas.style.visibility = "";
  return { started: players.length, stillPlayingAtEnd: stillPlaying, results };
}
