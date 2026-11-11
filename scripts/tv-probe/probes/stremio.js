// Stremio add-ons on the TV (PLAN.md, "Stremio add-ons", step 8), with the
// test server's made-up add-on (scripts/test-streams/stremio.mjs) added to
// the signed-in account's profile: /sync/add-list?kind=stremio&profiles=…
// About 40 s. It uses the classic Movies and Series, and puts back the
// layout the profile had after.
//
// 1. Chooses `profile`, and waits for the add-on's manifest.
// 2. Movies: its catalog shows as a group, a second page loads, and search
//    finds its films.
// 3. A film's details come from the add-on.
// 4. Play opens the stream picker; its first stream plays, the subtitle
//    files are offered, and the SRT one, chosen with the keys, keeps time
//    with the film's clock.
// 5. The film with only a torrent and a Referer stream says why none plays.
// 6. An episode's streams, and the next episode's with the same binge group.
//
// Input:
//   "profile": "Living room"

async function probe(input) {
  const app = window.velio;
  if (!app?.addons) return { error: "window.velio.addons is missing: deploy the app first" };
  const { addons, profiles, player, vod } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (test, ms = 15_000) => {
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
  const KEY = { down: 40, enter: 13, back: 10009 };
  const result = {};

  // 1.
  const wanted = profiles.list().find(one => one.name === (input.profile || "Living room"));
  if (!wanted) return { error: "No such profile", profiles: profiles.list().map(one => one.name) };
  if (profiles.currentId() !== wanted.id) profiles.choose(wanted.id);
  const layoutBefore = app.vodLayout.layout();
  app.vodLayout.set("classic");
  result.manifestMs = await waitFor(() => addons.states().some(state => state.manifest), 20_000);
  result.addons = addons.states().map(state => ({
    name: state.manifest?.name ?? state.list.name,
    problem: state.problem,
    catalogs: state.manifest?.catalogs.map(one => one.name),
  }));
  if (result.manifestMs === undefined) return result;

  // 2.
  location.hash = "#/movies";
  const grid = () => app.moviesGrid;
  const addonGroup = () =>
    grid()
      ?.rows()
      .find(row => row.id.startsWith("addon:"));
  result.groupMs = await waitFor(() => (addonGroup()?.items.length ?? 0) > 0, 20_000);
  const group = addonGroup();
  result.group = group && { label: group.label, items: group.items.length };
  const [catalog] = addons.catalogs("movie");
  // The page may already be asking for its second page itself.
  const page2 = () => addons.pages()[catalog.key];
  await waitFor(() => !page2()?.loading);
  if ((page2()?.items.length ?? 0) <= 20) await addons.loadPage(catalog);
  await waitFor(() => !page2()?.loading);
  result.afterSecondPage = addons.pages()[catalog.key]?.items.length;
  const searchStart = performance.now();
  result.search = (await addons.search("movie", "a")).length;
  result.searchMs = Math.round(performance.now() - searchStart);

  // 3.
  const films = group?.items ?? [];
  const film = films[0];
  const details = await vod.filmDetails(film);
  result.details = {
    name: film.name,
    plot: Boolean(details.plot),
    cast: details.cast,
    durationMs: details.durationMs,
  };

  // 4.
  app.moviesPage.play(film);
  const picker = () => app.streamPicker;
  result.streamsMs = await waitFor(() => (picker()?.streams().length ?? 0) > 0);
  result.streams = picker()
    ?.streams()
    .map(one => `${one.addonName} · ${one.stream.name.replace("\n", " ")}`);
  picker()?.pick();
  const page = () => app.playPage;
  result.playingMs = await waitFor(() => page() && player.status().state === "playing", 20_000);
  result.stream = player.status().stream?.url;
  await waitFor(() => (page()?.files().length ?? 0) > 0, 5000);
  result.files = page()
    ?.files()
    .map(one => `${one.language} · ${one.from}`);
  // Down opens the choices; Down again to the SRT file, then OK.
  press(KEY.down);
  await sleep(300);
  for (let i = 0; i < 10; i++) {
    const row = page().rows()[page().trackCursor()];
    if (row?.type === "file" && row.id.endsWith("/srt")) break;
    press(KEY.down);
    await sleep(150);
  }
  press(KEY.enter);
  result.subtitleMs = await waitFor(() => Boolean(page()?.externalText()), 10_000);
  // The cue says the film's clock, such as "SRT 0:01:05"; the player's position should agree.
  const checks = [];
  for (let i = 0; i < 4; i++) {
    await sleep(700);
    const text = page()?.externalText();
    const clock = /(\d+):(\d\d):(\d\d)/.exec(text ?? "");
    const at = player.position();
    if (clock)
      checks.push(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) - Math.floor(at / 1000));
    else checks.push(text ?? null);
  }
  result.subtitle = { chosen: page()?.externalChosen(), text: page()?.externalText(), secondsOff: checks };
  // Back closes the choices, hides the bar, then leaves.
  for (let i = 0; i < 3 && page(); i++) {
    press(KEY.back);
    await sleep(700);
  }
  await waitFor(() => location.hash === "#/movies" && !page(), 5000);

  // 5. Back from watching reopens the film's page. (A browser that can't
  // play the film, such as old Chromium, is still on the player page.)
  if (!app.moviesPage) {
    location.hash = "#/movies";
    await waitFor(() => app.moviesPage, 5000);
  }
  result.reopened = app.moviesPage?.open()?.name;
  const torrent = films[1];
  app.moviesPage.play(torrent);
  await waitFor(() => picker()?.found() !== undefined);
  result.pickerFocus = app.focusPath().slice(0, 3);
  const found = picker()?.found() ?? [];
  result.unplayable = {
    streams: picker()?.streams().length,
    unplayable: found.reduce((sum, one) => sum + one.unplayable, 0),
    needReferer: found.reduce((sum, one) => sum + one.needReferer, 0),
  };
  press(KEY.back);
  result.pickerClosed = (await waitFor(() => !picker(), 3000)) !== undefined;

  // 6.
  const [show] = addons.catalogs("series");
  await addons.loadPage(show);
  const series = addons.pages()[show.key]?.items[0];
  const meta = series && (await addons.meta("series", series.id));
  const [first, second] = meta?.videos ?? [];
  if (first && second) {
    const one = await addons.streams("series", first.id);
    const two = await addons.streams("series", second.id);
    result.episodes = {
      first: first.id,
      streams: one.flatMap(f => f.streams.map(s => s.bingeGroup)),
      next: two.flatMap(f => f.streams.map(s => s.bingeGroup)),
    };
  }
  location.hash = "#/";
  app.vodLayout.set(layoutBefore);
  return result;
}
