// Phase 6, step 6: reminders' notices (src/components/ReminderNotice.tsx).
// It sets reminders for programmes about to start on a channel with a
// guide, as "Remind me" in the guide would, then has the notice check for
// them at once instead of within 10 s. About 15 s.
//
// 1. A notice shows over the guide; Back dismisses it, and the guide has
//    the keys again.
// 2. Another shows; OK opens its channel, full screen.
// 3. A reminder for a programme later today is kept for the next start:
//    run it again with "check": true after a restart.
//
// Input, all optional:
//   "check": true   only say whether the reminder from step 3 was kept

async function probe(input) {
  const app = window.velio;
  if (!app?.reminders) return { error: "window.velio.reminders is missing: deploy the app first" };
  const { reminders, lineup, guide, player } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (test, ms = 10_000) => {
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
  const LATER = "Probe: later today";
  if (input.check) {
    return {
      kept: reminders.all().filter(one => one.title === LATER).length === 1,
      all: reminders.all().length,
    };
  }
  await waitFor(() => lineup.channels().length > 0 && app.reminderNotice);
  const notice = app.reminderNotice;
  const DAY = 86_400_000;
  const now = Date.now();

  // Two channels with a guide, and a programme each that starts soon.
  const picks = [];
  // The first few hundred channels are enough; reading every guide is slow.
  for (const channel of lineup.channels().slice(0, 300)) {
    if (!channel.guideId || picks.length === 2) continue;
    const programmes = await guide.day(channel.source, channel.guideId, Math.floor(now / DAY));
    const soon = programmes.find(p => p.start > now + 5000);
    if (soon) picks.push({ channel, programme: soon });
  }
  console.log(
    "[probe]",
    "picked",
    JSON.stringify(picks.map(pick => [pick.channel.name, pick.programme.title])),
  );
  if (picks.length < 2) return { error: "No channels with programmes starting soon" };
  const remind = ({ channel, programme }, start) =>
    reminders.add({
      channelId: channel.id,
      channelName: channel.name,
      title: `Probe: ${programme.title}`,
      start,
      stop: start + (programme.stop - programme.start),
    });

  // Reminders from earlier runs go, and any notice showing.
  for (const one of reminders.all())
    if (one.title.startsWith("Probe:")) reminders.remove(one.channelId, one.start);
  for (let left = notice.queue().length; left > 0; left--) {
    press(10009);
    await sleep(200);
  }

  const result = {};
  location.hash = "#/";
  await sleep(1500);
  // Into the guide, from the menu.
  press(39);
  await sleep(300);
  const before = notice.queue().length;

  // 1. Due in 40 s: shows now. Back dismisses it.
  remind(picks[0], Date.now() + 40_000);
  notice.check();
  // The notice takes the keys once it's drawn.
  await sleep(300);
  result.shown = (await waitFor(() => notice.queue().length === before + 1, 2000)) !== undefined;
  result.title = notice.queue()[0]?.title === `Probe: ${picks[0].programme.title}`;
  result.dueAgain = reminders.due().length === 0;
  press(10009);
  result.dismissedByBack = (await waitFor(() => notice.queue().length === before, 2000)) !== undefined;
  // The guide has the keys again: Down moves its cursor.
  const live = app.guidePage;
  const cursorBefore = live?.cursor?.();
  press(40);
  await sleep(400);
  result.guideHasKeys = live.cursor() !== cursorBefore;

  // 2. OK watches the channel.
  remind(picks[1], Date.now() + 30_000);
  notice.check();
  // The notice takes the keys once it's drawn.
  await sleep(300);
  await waitFor(() => notice.queue().length === before + 1, 2000);
  press(13);
  const opened = await waitFor(
    () => location.hash === "#/watch" && player.status().state === "playing",
    10_000,
  );
  result.okWatches = opened !== undefined;
  result.watching =
    player.status().stream?.url === picks[1].channel.url
      ? picks[1].channel.name
      : player.status().stream?.url;
  press(10009);
  await sleep(500);

  // 3. One for later today, for the next start.
  for (const one of reminders.all()) if (one.title === LATER) reminders.remove(one.channelId, one.start);
  reminders.add({
    channelId: picks[0].channel.id,
    channelName: picks[0].channel.name,
    title: LATER,
    start: now + 3 * 3600_000,
    stop: now + 4 * 3600_000,
  });
  result.later = reminders.all().some(one => one.title === LATER);
  return result;
}
