// Phase 6, step 2: catch-up, through the player page (src/pages/Play.tsx),
// in every catch-up style the sources have. It needs sources from the test
// server with catch-up channels (the `sources` probe), and reads the
// server's /catchup/log to check the time each recording was asked for.
// About 10 s per style, and 15 s more for the end-of-programme check.
//
// For each style: a programme that ended at least half an hour ago plays
// from its start (the log's start must be the programme's); two presses of
// Right seek a minute on, which asks for the recording again (the log's
// start must be a minute later); then, for the first style only, a jump to
// ten seconds before the end, after which the next programme must play.
//
// Input:
//   "server": "http://<dev-ip>:8090"   the test server (required)
//   "styles": ["xtream", ...]           only these; every style by default
//   "end": true                         check the end of a programme too

async function probe(input) {
  const app = window.velio;
  if (!app?.handPlay) return { error: "window.velio.handPlay is missing: deploy the app first" };
  if (!input.server) return { error: 'Give the test server\'s address as "server"' };
  const { lineup, guide, player } = app;
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
  const press = keyCode => {
    document.dispatchEvent(new KeyboardEvent("keydown", { keyCode, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { keyCode, bubbles: true }));
  };
  const lastAsked = async () => (await (await fetch(`${input.server}/catchup/log`)).json())[0];
  const page = () => app.playPage;
  const state = () => player.status().state;
  const DAY = 86_400_000;
  const now = Date.now();

  // One channel per source and style.
  const picks = new Map();
  for (const channel of lineup.channels()) {
    if (!channel.catchup || !channel.guideId) continue;
    const key = `${channel.source}|${channel.catchup.type}`;
    if (!picks.has(key)) picks.set(key, channel);
  }
  const wanted = [...picks.values()].filter(
    channel => !input.styles || input.styles.includes(channel.catchup.type),
  );

  const results = [];
  let checkedEnd = !input.end;
  for (const channel of wanted) {
    const result = { style: channel.catchup.type, channel: channel.name, source: channel.source };
    results.push(result);
    const day = Math.floor(now / DAY);
    const programmes = [
      ...(await guide.day(channel.source, channel.guideId, day - 1)),
      ...(await guide.day(channel.source, channel.guideId, day)),
    ];
    const ended = programmes.filter(p => p.stop < now - 30 * 60_000 && p.start > now - DAY);
    const programme = ended[ended.length - 1];
    if (!programme) {
      result.error = "no programme to play";
      continue;
    }
    result.programme = { title: programme.title, start: new Date(programme.start).toISOString() };
    app.handPlay({ kind: "catchup", channel, programme });
    location.replace("#/play");
    result.startMs = await waitFor(() => page() && state() === "playing");
    if (result.startMs === undefined) {
      result.error = `didn't play: ${state()} ${player.status().error ?? ""}`;
      press(413);
      await waitFor(() => !page(), 3000);
      continue;
    }
    const asked = await lastAsked();
    result.asked = { style: asked?.style, start: new Date(asked?.start).toISOString(), path: asked?.path };
    result.startRight = asked?.start === programme.start;
    await sleep(3000);
    result.placeAfter3s = Math.round((page().place() - programme.start) / 1000);

    // Two presses of Right: a minute on.
    page().seek(1);
    page().seek(1);
    result.seekTarget = Math.round((page().seekTarget() - programme.start) / 1000);
    await waitFor(() => page().seekTarget() === undefined, 3000);
    result.reopenMs = await waitFor(() => state() === "playing" && page().basePosition() !== undefined);
    const again = await lastAsked();
    result.seekAsked = Math.round((again.start - programme.start) / 1000);
    await sleep(2000);
    result.placeAfterSeek = Math.round((page().place() - programme.start) / 1000);

    if (!checkedEnd) {
      checkedEnd = true;
      // Ten seconds before the end: the next programme follows.
      page().jumpTo(programme.stop - 10_000);
      const next = programmes.find(p => p.start >= programme.stop);
      const moved = await waitFor(() => page()?.request()?.programme?.start === next?.start, 40_000);
      await waitFor(() => state() === "playing");
      const last = await lastAsked();
      result.end = {
        nextTitle: next?.title,
        nextPlayedAfterMs: moved,
        askedFromNextStart: last?.start === next?.start,
        state: state(),
      };
    }
    log(result.style, result);
    // Stop leaves for the guide.
    press(413);
    await waitFor(() => !page(), 3000);
    await sleep(500);
  }
  return { results };
}
