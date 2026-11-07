// Phase 6, steps 3–5: films and series, through the Movies and Series pages
// and the player page, with remote keys where it matters. It needs the test
// server's sources with films (the `sources` probe: the Xtream API, its
// get.php playlist, the plain playlist with ?vod=1). About a minute.
//
// 1. Movies: a film from the source named "source" opens from the grid
//    with OK, shows its details, plays, seeks 90 s on, pauses and plays on.
//    Stop goes back to its page, which now offers Resume; Continue watching
//    has it. Resume plays from where it was left; a jump to just before
//    its end finishes it, and it leaves Continue watching.
// 2. Series: a series' first episode plays from its page, and when it ends
//    the next one follows. Back on the series' page, the cursor is on it.
// 3. One film and one episode from every source with films play.
// Run it again with "check": true after a restart to see what was kept.
//
// Input, all optional:
//   "source": "Xtream API"   the source for steps 1 and 2
//   "check": true            only report what the resume list holds for the
//                            film and episodes a previous run played

async function probe(input) {
  const app = window.tiviplayer;
  if (!app?.vod || !app?.watched) return { error: "window.tiviplayer.vod is missing: deploy the app first" };
  const { vod, watched, player, library } = app;
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
  const press = keyCode => {
    document.dispatchEvent(new KeyboardEvent("keydown", { keyCode, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { keyCode, bubbles: true }));
  };
  const KEY = { left: 37, right: 39, enter: 13, back: 10009, stop: 413 };
  const state = () => player.status().state;
  const playing = () => state() === "playing";
  const page = () => app.playPage;
  const waited = async (...args) => (await waitFor(...args)) !== undefined;
  const secs = ms => (ms === undefined ? undefined : Math.round(ms / 1000));

  const source = library.sources().find(one => one.name === (input.source ?? "Xtream API"));
  if (!source) return { error: `No source named ${input.source ?? "Xtream API"}` };
  await waitFor(() => !vod.loading() && vod.films().length > 0, 20_000);

  if (input.check) {
    return {
      films: watched
        .all()
        .filter(entry => entry.kind === "film")
        .map(entry => ({ title: entry.title, at: secs(entry.positionMs), finished: entry.finished })),
      episodes: watched.latestEpisodes().map(entry => ({
        title: entry.title,
        season: entry.season,
        episode: entry.episode,
        at: secs(entry.positionMs),
      })),
    };
  }

  // Leaves a film's or an episode's place in the grid, focused, and opens it with OK.
  const trace = [];
  const note = (label, grid) =>
    trace.push([label, location.hash, app.focusPath?.().length, grid?.cursor(), grid?.area()]);
  const openFromGrid = async (route, gridName, pageName, item) => {
    location.hash = `#/${route}`;
    await waitFor(() => app[gridName]?.items().length > 0);
    await sleep(300);
    const grid = app[gridName];
    grid.setFilterId("all");
    await sleep(100);
    const index = grid.items().findIndex(one => one.key === item.key);
    grid.place(index);
    await sleep(100);
    note(`${route} placed ${index}`, grid);
    // From the menu into the page, then OK. If the grid had the keys
    // already, Right moved its cursor instead, and Left puts it back.
    press(KEY.right);
    await sleep(300);
    note("right", grid);
    if (grid.cursor() !== index) press(KEY.left);
    await sleep(100);
    press(KEY.enter);
    const opened = await waitFor(() => app[pageName]?.open()?.key === item.key, 5000);
    note(`enter ${opened}`, grid);
    return opened;
  };

  const result = { source: source.name };

  // 1. A film.
  const film = vod.films().find(one => one.source === source.id);
  if (!film) return { error: "The source has no films" };
  watched.remove(film.key);
  const filmResult = { title: film.name };
  result.film = filmResult;
  filmResult.openedMs = await openFromGrid("movies", "moviesGrid", "moviesPage", film);
  if (filmResult.openedMs === undefined) return { ...result, error: "OK didn't open the film" };
  await waitFor(() => app.filmPanel?.details() !== undefined, 5000);
  const details = app.filmPanel.details();
  filmResult.details = {
    plot: Boolean(details?.plot),
    director: details?.director,
    durationMs: details?.durationMs,
  };
  filmResult.actions = app.filmPanel.actions().map(action => action.id);
  press(KEY.enter);
  filmResult.startMs = await waitFor(() => page() && playing());
  if (filmResult.startMs === undefined) return { ...result, error: `The film didn't play: ${state()}` };
  filmResult.duration = secs(player.duration());
  await sleep(1500);
  // Three presses of Right: 90 s on.
  press(KEY.right);
  press(KEY.right);
  press(KEY.right);
  filmResult.seekTarget = secs(page().seekTarget());
  await waitFor(() => page().seekTarget() === undefined, 3000);
  await waitFor(() => playing() && Math.abs(player.position() - 91_500) < 5000, 8000);
  filmResult.positionAfterSeek = secs(player.position());
  press(KEY.enter);
  filmResult.paused = (await waited(() => state() === "paused", 3000)) && page().paused();
  await sleep(1500);
  const pausedAt = player.position();
  press(KEY.enter);
  await waitFor(playing, 3000);
  filmResult.heldWhilePaused = Math.abs(player.position() - pausedAt) < 1000;
  await sleep(1500);
  press(KEY.stop);
  filmResult.backOnItsPage = await waited(() => !page() && app.moviesPage?.open()?.key === film.key, 8000);
  await waitFor(() => app.filmPanel?.actions()[0]?.id === "resume", 3000);
  filmResult.saved = secs(watched.get(film.key)?.positionMs);
  filmResult.actionsAfter = app.filmPanel?.actions().map(action => action.id);
  filmResult.inContinue = app.moviesPage.continueItems().some(one => one.key === film.key);
  // Resume.
  press(KEY.enter);
  await waitFor(() => page() && playing());
  await sleep(1000);
  filmResult.resumedAt = secs(player.position());
  // Just before its end, it finishes.
  page().jumpTo(player.duration() - 4000);
  filmResult.endedBackOnItsPage = await waited(
    () => !page() && app.moviesPage?.open()?.key === film.key,
    15_000,
  );
  filmResult.finished = watched.get(film.key)?.finished;
  filmResult.leftContinue = !app.moviesPage.continueItems().some(one => one.key === film.key);
  log("film", filmResult);
  press(KEY.back);
  await sleep(300);

  // 2. A series: the first episode, then the next.
  const show = vod.series().find(one => one.source === source.id);
  const seriesResult = { title: show?.name };
  result.series = seriesResult;
  if (show) {
    const showDetails = await vod.seriesDetails(show);
    const episodes = showDetails.seasons.flatMap(season => season.episodes);
    for (const episode of episodes) watched.remove(`${show.source}/${episode.id}`);
    seriesResult.episodes = episodes.length;
    seriesResult.openedMs = await openFromGrid("series", "seriesGrid", "seriesPage", show);
    if (seriesResult.openedMs !== undefined) {
      await waitFor(() => app.seriesPanel?.details() !== undefined, 5000);
      press(KEY.enter);
      seriesResult.startMs = await waitFor(() => page() && playing());
      const first = page()?.request()?.item;
      seriesResult.first = first && `S${first.season}E${first.episode}`;
      await sleep(1000);
      page()?.jumpTo(player.duration() - 4000);
      const nextKey = `${show.source}/${episodes[1]?.id}`;
      seriesResult.nextAfterMs = await waitFor(
        () => page()?.request()?.item?.key === nextKey && playing(),
        15_000,
      );
      const second = page()?.request()?.item;
      seriesResult.next = second && `S${second.season}E${second.episode}`;
      seriesResult.firstFinished = watched.get(`${show.source}/${episodes[0].id}`)?.finished;
      await sleep(1500);
      press(KEY.stop);
      await waitFor(() => !page() && app.seriesPage?.open()?.key === show.key, 8000);
      await waitFor(() => app.seriesPanel?.episodes !== undefined, 3000);
      await sleep(500);
      const panel = app.seriesPanel;
      const cursorEpisode = panel?.episodes()[panel.cursor()];
      seriesResult.cursorOn = cursorEpisode && `S${cursorEpisode.season}E${cursorEpisode.episode}`;
      seriesResult.inContinue = app.seriesPage.continueItems().some(one => one.key === show.key);
      press(KEY.back);
      await sleep(300);
    } else {
      seriesResult.error = "OK didn't open the series";
      seriesResult.trace = trace;
    }
    log("series", seriesResult);
  }

  // 3. A film and an episode from every source with films.
  result.everySource = [];
  for (const other of library.sources()) {
    const films = vod.films().filter(one => one.source === other.id);
    const shows = vod.series().filter(one => one.source === other.id);
    if (films.length === 0 && shows.length === 0) continue;
    const row = { source: other.name, films: films.length, series: shows.length };
    result.everySource.push(row);
    const plays = [];
    if (films[1]) plays.push(["film", () => app.moviesPage, films[1]]);
    if (shows[1]) plays.push(["episode", () => app.seriesPage, shows[1]]);
    for (const [kind, , item] of plays) {
      location.hash = kind === "film" ? "#/movies" : "#/series";
      await sleep(500);
      if (kind === "film") app.moviesPage.play(item);
      else {
        const itemDetails = await vod.seriesDetails(item);
        const episode = itemDetails.seasons[0]?.episodes[0];
        if (!episode) {
          row[kind] = "no episodes";
          continue;
        }
        app.handPlay({
          kind: "vod",
          item: { key: `${item.source}/${episode.id}`, kind: "episode", title: episode.title },
          stream: { url: episode.url, live: false },
          back: "/series",
        });
        location.replace("#/play");
      }
      const started = await waitFor(() => page() && playing());
      row[kind] =
        started === undefined ? `didn't play: ${state()} ${player.status().error ?? ""}` : `${started} ms`;
      press(KEY.stop);
      await waitFor(() => !page(), 5000);
      await sleep(300);
      // Closes the film's page, which opens again after watching. (Back on
      // the menu would close the app.)
      if (app.moviesPage?.open() || app.seriesPage?.open()) press(KEY.back);
      await sleep(300);
    }
  }
  location.hash = "#/";
  return result;
}
