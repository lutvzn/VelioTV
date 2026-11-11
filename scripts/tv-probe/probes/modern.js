// The modern Movies and Series on the TV (PLAN.md, "Movies and Series by
// title", step 8), with the test server's made-up Cinemeta and add-on
// (scripts/test-streams/stremio.mjs), and a source with the server's films,
// such as its Xtream login. About 40 s.
//
// 1. Chooses `profile`, points the app at `cinemeta`, `wikidata` and `tmdb`, and
//    turns the modern layout on.
// 2. Times matching the films and series to Cinemeta, and counts the
//    titles: matched, joined from two or more links, and left unmatched;
//    and the matches by how they were found (by name, a guessed name, or
//    the TMDB id, through TMDB or Wikidata, or TMDB's search).
// 3. Movies: the groups, in order, with their titles.
// 4. A film that a source and the add-on both have: the picker lists the
//    source's copy, then the add-on's streams; each plays.
// 5. A series' episodes, joined from Cinemeta and the sources.
// Puts back the layout and the addresses after, unless `keep` is true.
//
// Input:
//   "profile": "Living room"
//   "cinemeta": "http://<dev-ip>:8091/cinemeta/manifest.json"
//   "wikidata": "http://<dev-ip>:8091/wikidata/sparql"
//   "tmdb": "http://<dev-ip>:8091/tmdb/3", or "" for TMDB itself (with the build's key)
//   "matchMs": 30000, how long to wait for matching
//   "keep": false

async function probe(input) {
  const app = window.velio;
  if (!app?.titleMatcher) return { error: "window.velio.titleMatcher is missing: deploy the app first" };
  const { addons, cinemeta, profiles, player, vod, titleMatcher, vodLayout } = app;
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
  const result = {};

  // 1.
  const wanted = profiles.list().find(one => one.name === (input.profile || "Living room"));
  if (!wanted) return { error: "No such profile", profiles: profiles.list().map(one => one.name) };
  if (profiles.currentId() !== wanted.id) profiles.choose(wanted.id);
  const before = {
    layout: vodLayout.layout(),
    cinemeta: app.cinemetaUrl(),
    wikidata: app.wikidataUrl(),
    tmdb: app.tmdbUrl(),
  };
  if (input.cinemeta) app.setCinemetaUrl(input.cinemeta);
  if (input.wikidata) app.setWikidataUrl(input.wikidata);
  if (input.tmdb !== undefined) app.setTmdbUrl(input.tmdb);
  result.tmdbOn = app.tmdbOn();
  vodLayout.set("modern");
  // The add-ons' manifests as they are now, not as kept.
  await addons.refresh();
  addons.forget();
  result.manifestMs = await waitFor(() => cinemeta.states().some(state => state.manifest), 20_000);
  result.cinemeta = cinemeta.states().map(state => ({ url: state.list.url, problem: state.problem }));
  await waitFor(() => vod.films().length > 0 && !vod.loading(), 20_000);
  result.films = vod.films().length;
  result.series = vod.series().length;
  if (result.manifestMs === undefined || result.films === 0) return result;

  // 2. Up to `matchMs`, with the frames drawn meanwhile.
  const start = performance.now();
  let worstFrame = 0;
  let longFrames = 0;
  let last = performance.now();
  let watching = true;
  const frame = now => {
    const took = now - last;
    last = now;
    if (took > worstFrame) worstFrame = took;
    if (took > 100) longFrames++;
    if (watching) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await waitFor(() => titleMatcher.progress().running, 3000);
  await waitFor(() => !titleMatcher.progress().running, input.matchMs || 30_000);
  watching = false;
  result.matching = {
    ms: Math.round(performance.now() - start),
    ...titleMatcher.progress(),
    worstFrameMs: Math.round(worstFrame),
    longFrames,
  };
  const via = {};
  for (const one of [...vod.films(), ...vod.series()]) {
    const match = titleMatcher.matchOf(one);
    if (match) via[match.via || "before"] = (via[match.via || "before"] || 0) + 1;
  }
  result.matching.via = via;
  await sleep(3200);

  // 3.
  location.hash = "#/movies";
  const page = () => app.moviesPage;
  result.openMs = await waitFor(() => page()?.titles && app.moviesGrid?.rows().length > 0, 10_000);
  // How long the titles take to join, as each time matches come in.
  const joinMs = [];
  for (let i = 0; i < 3; i++) {
    const joinStart = performance.now();
    app.mergeFilms(vod.films(), titleMatcher.matchOf, []);
    joinMs.push(Math.round(performance.now() - joinStart));
  }
  result.joinMs = joinMs;
  const titles = page().titles().titles;
  result.titles = {
    all: titles.length,
    matched: titles.filter(one => one.imdb && one.links.length > 0).length,
    joined: titles.filter(one => one.links.length > 1).length,
    unmatched: titles.filter(one => !one.imdb && one.links.length > 0).length,
    addonOnly: titles.filter(one => one.links.length === 0).length,
  };
  await waitFor(
    () => app.moviesGrid?.rows().some(row => row.id === "popular" && row.items.length > 0),
    10_000,
  );
  result.groups = app.moviesGrid
    .rows()
    .map(
      row =>
        `${row.id === `category:${row.label}` ? "category" : row.id.split(":")[0]}: ${row.label} (${row.items.length})`,
    );
  const sample = titles.find(one => one.imdb && one.links.length > 0);
  result.sample = sample && {
    name: sample.name,
    key: sample.key,
    genres: sample.genres,
    links: sample.links.map(link => `${link.source} · ${link.name}`),
  };

  // 4. A film the add-on has too (it has the first 60), which isn't the one with no playable streams.
  const both = titles.find(
    one =>
      one.imdb &&
      one.links.length > 0 &&
      one.imdb !== "tt0010001" &&
      addons.answers("stream", "movie", one.imdb),
  );
  const picker = () => app.streamPicker;
  const playRow = async (title, which) => {
    page().play(title);
    await waitFor(() => (picker()?.rows().length ?? 0) > 0);
    await waitFor(() => picker()?.found() !== undefined, 8000);
    const rows = picker()?.rows() ?? [];
    const at = rows.findIndex(row => row.choice.kind === which);
    if (at < 0) {
      press(10009);
      return { rows: rows.map(row => row.text), error: `no ${which} row` };
    }
    picker().setCursor(at);
    picker().pick();
    const playingMs = await waitFor(() => app.playPage && player.status().state === "playing", 20_000);
    const stream = player.status().stream?.url;
    for (let i = 0; i < 3 && app.playPage; i++) {
      press(10009);
      await sleep(700);
    }
    await waitFor(() => location.hash === "#/movies" && !app.playPage, 5000);
    if (!page()) {
      location.hash = "#/movies";
      await waitFor(() => page(), 5000);
    }
    return { rows: rows.map(row => `${row.choice.kind}: ${row.text} — ${row.detail}`), playingMs, stream };
  };
  if (both) {
    result.both = { name: both.name, imdb: both.imdb };
    result.iptv = await playRow(both, "iptv");
    result.reopened = page()?.open()?.name;
    result.addon = await playRow(both, "addon");
  }

  // 5.
  location.hash = "#/series";
  await waitFor(() => app.seriesPage?.titles, 10_000);
  const shows = app.seriesPage.titles().titles;
  result.seriesTitles = {
    all: shows.length,
    matched: shows.filter(one => one.imdb && one.links.length > 0).length,
    unmatched: shows.filter(one => !one.imdb && one.links.length > 0).length,
  };
  const show = shows.find(one => one.imdb && one.links.length > 0);
  if (show) {
    const loadStart = performance.now();
    const details = await app.seriesPage.load(show);
    const [first] = details.seasons[0]?.episodes ?? [];
    result.show = {
      name: show.name,
      loadMs: Math.round(performance.now() - loadStart),
      seasons: details.seasons.map(one => `${one.season}: ${one.episodes.length}`),
      first: first && { stremio: first.stremio, links: (first.links ?? []).map(link => link.episode.url) },
    };
  }

  location.hash = "#/";
  if (!input.keep) {
    vodLayout.set(before.layout);
    app.setCinemetaUrl(
      before.cinemeta === "https://v3-cinemeta.strem.io/manifest.json" ? "" : before.cinemeta,
    );
    app.setWikidataUrl(before.wikidata === "https://query.wikidata.org/sparql" ? "" : before.wikidata);
    app.setTmdbUrl(before.tmdb === "https://api.themoviedb.org/3" ? "" : before.tmdb);
  }
  return result;
}
