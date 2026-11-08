// Phase 7, step 2: pausing live TV on the live page (src/pages/Watch.tsx),
// with the remote's keys. It needs the test server's sources, with a
// catch-up channel and one without (the `sources` probe), and reads the
// server's /catchup/log for the time the archive was asked from. About 90 s.
//
// On a channel with catch-up:
// 1. Pause, then Play after 3 s: it plays on in place, on the live page.
// 2. Pause, then Play after 15 s: the player page plays the archive from
//    where it paused, and says how far behind live; Fast-forward to now
//    goes back to live.
// 3. Rewind: the archive from a minute ago; Back goes back to live.
// On a channel without:
// 4. Pause, then Play after 15 s: live again, on the live page.
// 5. Pause, then Back: live again.
//
// Input:
//   "server": "http://<dev-ip>:8090"   the test server (required)
//   "long": 15                         seconds for the long pauses

async function probe(input) {
  const app = window.velio;
  if (!app?.live && !app?.lineup) return { error: "window.velio is missing: deploy the app first" };
  if (!input.server) return { error: 'Give the test server\'s address as "server"' };
  const { lineup, player } = app;
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
  const waited = async (...args) => (await waitFor(...args)) !== undefined;
  const press = keyCode => {
    document.dispatchEvent(new KeyboardEvent("keydown", { keyCode, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { keyCode, bubbles: true }));
  };
  const KEY = { back: 10009, play: 415, pause: 19, rewind: 412, fastForward: 417 };
  const LONG = (input.long ?? 15) * 1000;
  const live = () => app.live;
  const page = () => app.playPage;
  const state = () => player.status().state;
  const playing = () => state() === "playing";
  const onLive = () => location.hash === "#/watch" && live()?.watching() && !page();
  const lastAsked = async () => (await (await fetch(`${input.server}/catchup/log`)).json())[0];
  const secs = ms => (ms === undefined ? undefined : Math.round(ms / 1000));

  await waitFor(() => lineup.channels().length > 0, 30_000);
  const channels = lineup.channels();
  // A catch-up style that asks for the time to the second, and one without.
  const withArchive =
    channels.find(channel => channel.catchup?.type === "flussonic" && channel.guideId) ??
    channels.find(channel => channel.catchup && channel.guideId);
  const without = channels.find(channel => !channel.catchup && channel.url.includes("/ts/"));
  if (!withArchive || !without) return { error: "Needs a catch-up channel and one without" };

  // Full screen on `channel`, playing.
  const watch = async channel => {
    if (location.hash !== "#/watch") {
      location.hash = "#/watch";
      await waitFor(() => live()?.zapper, 5000);
    }
    live().zapper.tune(channel, live().zapper.group());
    await waitFor(() => live().zapper.playing()?.id === channel.id && playing() && live().watching());
    // Its banner goes, so Back isn't spent on it.
    await sleep(500);
    if (live().bannerShown()) press(KEY.back);
    await sleep(300);
    return playing();
  };
  const pause = async () => {
    press(KEY.pause);
    return waited(() => live().pausedAt() !== undefined && state() === "paused", 3000);
  };

  const result = { withArchive: [withArchive.name, withArchive.catchup.type], without: without.name };

  // 1. A short pause.
  {
    const step = { playing: await watch(withArchive) };
    result.short = step;
    await sleep(2000);
    step.paused = await pause();
    const at = player.position();
    await sleep(3000);
    step.hint = live().pausedHint();
    press(KEY.play);
    step.playedOn = await waited(() => playing() && live().pausedAt() === undefined, 5000);
    await sleep(1500);
    step.stayedLive = onLive();
    // Plays on from the pause: about 1.5 s on, not 4.5 s.
    step.movedSeconds = Math.round((player.position() - at) / 100) / 10;
    log("short", step);
  }

  // 2. A long pause, with catch-up.
  {
    const step = {};
    result.long = step;
    step.paused = await pause();
    const pausedAt = live().pausedAt();
    await sleep(LONG);
    step.hint = live().pausedHint();
    press(KEY.play);
    step.archiveMs = await waitFor(() => page() && playing(), 15_000);
    const request = page()?.request();
    step.fromLive = request?.fromLive;
    const asked = await lastAsked().catch(() => undefined);
    // How far the archive's start was from the pause (flussonic asks to the second).
    step.askedFromPauseSeconds = asked?.start === undefined ? undefined : secs(asked.start - pausedAt);
    await sleep(1500);
    step.behindSeconds = secs(Date.now() - page()?.place());
    // Fast-forward to now: Play.tsx's seek runs on to now, and goes live.
    for (let i = 0; i < 4; i++) press(KEY.fastForward);
    step.fastForwardLive = await waited(() => onLive() && playing(), 15_000);
    step.channel = live()?.zapper.playing()?.name;
    log("long", step);
  }

  // 3. Rewind a minute.
  {
    const step = {};
    result.rewind = step;
    await watch(withArchive);
    const pressed = Date.now();
    press(KEY.rewind);
    step.archiveMs = await waitFor(() => page() && playing(), 15_000);
    const asked = await lastAsked().catch(() => undefined);
    step.askedSecondsBack = asked?.start === undefined ? undefined : secs(pressed - asked.start);
    await sleep(1500);
    press(KEY.back);
    await sleep(300);
    // The first Back may only hide the bar.
    if (page()) press(KEY.back);
    step.backLive = await waited(() => onLive() && playing(), 15_000);
    step.channel = live()?.zapper.playing()?.name;
    log("rewind", step);
  }

  // 4. A long pause, without catch-up.
  {
    const step = { playing: await watch(without) };
    result.longWithout = step;
    await sleep(1000);
    step.paused = await pause();
    await sleep(LONG);
    step.hint = live().pausedHint();
    press(KEY.play);
    await sleep(500);
    step.reopened = state() !== "paused";
    step.liveAgain = await waited(() => onLive() && playing() && live().pausedAt() === undefined, 15_000);
    log("longWithout", step);
  }

  // 5. Back while paused.
  {
    const step = {};
    result.back = step;
    await sleep(2000);
    step.paused = await pause();
    await sleep(2000);
    press(KEY.back);
    step.cleared = await waited(() => live().pausedAt() === undefined, 2000);
    step.liveAgain = await waited(() => onLive() && playing(), 15_000);
    log("back", step);
  }
  return result;
}
