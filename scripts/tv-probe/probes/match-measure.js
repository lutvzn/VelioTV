// Title matching on a big source (PLAN.md, "Movies and Series by title"):
// waits on the Movies page until matching ends, sampling its progress and
// the frames each minute, then counts the source's matches by how they were
// found, with samples of the new ones (TMDB's search, close spellings) and
// names still unmatched. Run it after something sends titles to be matched
// again (a new CLEANING, or a source's first import); it may take 10-25
// minutes, so set PROBE_TIMEOUT=1800.
//
// Input:
//   "source": the source's name, as in Settings
//   "maxMs": 1500000, the longest to wait
//   "everyMs": 60000, how often to sample
// Waits for matching to end (up to maxMs), sampling progress and frames each minute, then counts the matches.
// A source's matches, from its blocks (and its one record from before them).
function keptOf(records, source) {
  const matches = {};
  const mine = records.filter(one => one.source === source && one.cinemeta === window.velio.cinemetaUrl());
  mine.sort((a, b) => (a.block === undefined ? -1 : a.block) - (b.block === undefined ? -1 : b.block));
  for (const one of mine)
    Object.assign(matches, typeof one.matches === "string" ? JSON.parse(one.matches) : one.matches);
  return mine.length > 0 ? { matches } : undefined;
}

async function probe(input) {
  const app = window.velio;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const setup = { tmdbOn: app.tmdbOn(), tmdbUrl: app.tmdbUrl(), cinemeta: app.cinemetaUrl() };
  // What each film was found by before, to sample only what this run found.
  const startRecords = await app.db.readTitleMatches(await app.db.openDb());
  const startSource = app.library.sources().find(one => one.name === input.source);
  const startRecord = keptOf(startRecords, startSource.id);
  const viaBefore = new Map();
  for (const key of Object.keys(startRecord ? startRecord.matches : {})) {
    const v = startRecord.matches[key];
    viaBefore.set(key, typeof v === "object" ? v.via || "before" : "none");
  }
  location.hash = "#/movies";
  const start = performance.now();
  let worst = 0,
    long = 0,
    last = performance.now(),
    on = true;
  const frame = now => {
    const took = now - last;
    last = now;
    if (took > worst) worst = took;
    if (took > 100) long++;
    if (on) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const samples = [];
  let started = false;
  while (performance.now() - start < (input.maxMs || 1_500_000)) {
    await sleep(input.everyMs || 60000);
    const p = app.titleMatcher.progress();
    samples.push({
      s: Math.round((performance.now() - start) / 1000),
      done: p.done,
      total: p.total,
      waitingMore: p.waitingMore,
      askedMore: p.askedMore,
      worstFrameMs: Math.round(worst),
      longFrames: long,
    });
    worst = 0;
    long = 0;
    if (p.running) started = true;
    if (started && !p.running) break;
  }
  on = false;
  await app.titleMatcher.flush();
  const status = await statusProbe(input);
  delete status.earlier;
  status.unmatchedSample = status.unmatchedSample && status.unmatchedSample.slice(0, 25);
  const records = await app.db.readTitleMatches(await app.db.openDb());
  const source = app.library.sources().find(one => one.name === input.source);
  const record = keptOf(records, source.id);
  const sample = (list, via) => {
    const found = list.filter(one => {
      const v = record.matches[one.key];
      return v && typeof v === "object" && v.via === via && viaBefore.get(one.key) !== via;
    });
    const step = Math.max(1, Math.floor(found.length / 40));
    return found
      .filter((_, i) => i % step === 0)
      .slice(0, 40)
      .map(one => {
        const v = record.matches[one.key];
        return `${one.name} → ${v.name} (${v.year})`;
      });
  };
  const films = app.vod.films().filter(one => one.source === source.id);
  status.searchFilms = sample(films, "tmdbSearch");
  status.searchSeries = sample(
    app.vod.series().filter(one => one.source === source.id),
    "tmdbSearch",
  ).slice(0, 20);
  status.tmdbFilms = sample(films, "tmdb").slice(0, 15);
  status.closeFilms = sample(films, "tmdbClose");
  // What became of the films matched by the provider's TMDB id before.
  const moved = {};
  for (const one of films) {
    if (viaBefore.get(one.key) !== "tmdb") continue;
    const v = record.matches[one.key];
    const now = typeof v === "object" ? v.via || "before" : "none";
    moved[now] = (moved[now] || 0) + 1;
  }
  status.tmdbBefore = moved;
  const fresh = {};
  for (const one of films) {
    const v = record.matches[one.key];
    const now = typeof v === "object" ? v.via || "before" : "none";
    if (viaBefore.get(one.key) !== now)
      fresh[(viaBefore.get(one.key) || "new") + ">" + now] =
        (fresh[(viaBefore.get(one.key) || "new") + ">" + now] || 0) + 1;
  }
  status.changedFilms = fresh;
  return { setup, ms: Math.round(performance.now() - start), samples, status };
}
// How many of each source's films and series matched Cinemeta so far.
async function statusProbe(input) {
  if (!input.source) return { error: "Give the source's name as source" };
  const app = window.velio;
  const { library, vod, titleMatcher, db } = app;
  const records = await db.readTitleMatches(await db.openDb());
  const out = { cinemeta: app.cinemetaUrl(), progress: titleMatcher.progress(), sources: [] };
  for (const source of library.sources()) {
    const record = keptOf(records, source.id);
    const matches = record ? record.matches : {};
    const count = list => {
      let looked = 0,
        matched = 0;
      const via = {};
      for (const item of list) {
        const value = matches[item.key];
        if (value === undefined) continue;
        looked++;
        if (typeof value === "object") {
          matched++;
          const how = value.via || "before";
          via[how] = (via[how] || 0) + 1;
        }
      }
      return {
        total: list.length,
        looked,
        matched,
        percent: looked ? Math.round((1000 * matched) / looked) / 10 : null,
        via,
      };
    };
    out.sources.push({
      name: source.name,
      films: count(vod.films().filter(film => film.source === source.id)),
      series: count(vod.series().filter(show => show.source === source.id)),
    });
  }
  // A sample of names not matched, to see why.
  const source = library.sources().find(one => one.name === input.source);
  const record =
    source && records.find(one => one.source === source.id && one.cinemeta === app.cinemetaUrl());
  if (record) {
    out.cleaning = record.cleaning;
    out.unmatchedSample = vod
      .films()
      .filter(film => film.source === source.id && typeof record.matches[film.key] === "number")
      .slice(0, 60)
      .map(film => film.name);
    const earlier = input.earlier || [];
    out.earlier = vod
      .films()
      .filter(film => film.source === source.id && earlier.includes(film.name))
      .map(film => {
        const value = record.matches[film.key];
        return `${film.name} → ${typeof value === "object" ? value.name + " (" + value.year + ")" : value === undefined ? "not yet" : "none"}`;
      });
  }
  return out;
}
