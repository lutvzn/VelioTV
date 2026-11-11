// Where a new source's matching time goes (PLAN.md, "Movies and Series by
// title"): a matcher of its own, built from the app's parts, matches a spread
// sample of the films, keeping nothing, while every request it makes is
// counted and timed by kind: Cinemeta's search by the cleaned name, by other
// names, and its details; TMDB's search and details; the provider's TMDB id.
// It reports the time to the end of the searches (with the films matched by
// then, and those still without their details) and of all, the
// requests of each kind (count, total and median time, how many were going
// at once on average), the matches by how they were found, and the progress
// every few seconds. About 1-2 minutes for 600 films. Needs the build's TMDB
// key (TMDB_API_KEY in .env); the app's own matcher should be idle.
//
// Input, all optional:
//   "count": 600          films
//   "offset": 0           from 0 to 1: which films are taken, so runs can differ
//   "uncached": true      Cinemeta asked in lower case, which its cache hasn't
//                          seen, as for a source no one has matched
//   "provider": false     ask the provider for TMDB ids (slow: about 3.4 a
//                          second); without, they're only counted
//   "concurrency": 5      the matcher's Cinemeta searches at once
//   "everyMs": 5000       how often progress is sampled
//   "maxMs": 300000

async function probe(input) {
  const app = window.velio;
  const parts = app.matchParts;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const count = input.count || 600;
  const uncached = input.uncached !== false;
  if (!app.tmdbOn()) return { error: "This build has no TMDB key" };
  for (let i = 0; i < 100 && app.vod.films().length === 0; i++) await sleep(200);

  // A spread sample, one film per cleaned name and year.
  const films = app.vod.films();
  const step = Math.max(1, Math.floor(films.length / (count * 1.5)));
  const seen = new Set();
  const items = [];
  const firstNames = new Set();
  for (let i = Math.floor((input.offset || 0) * step); i < films.length && items.length < count; i += step) {
    const film = films[i];
    const clean = app.cleanTitle(film.name, film.year);
    const id = `${app.nameKey(clean.title)}/${clean.year || ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    firstNames.add(clean.title);
    items.push({
      key: `probe/${film.key}`,
      film,
      source: "probe",
      type: "movie",
      name: film.name,
      year: film.year,
      category: film.category,
      askTmdb: film.providerId !== undefined,
    });
  }

  // Each kind of request: its times, and how many are going now.
  const kinds = {};
  const going = {};
  const timed = (kind, ask) => {
    const one = (kinds[kind] = kinds[kind] || { times: [], failed: 0 });
    going[kind] = (going[kind] || 0) + 1;
    const start = performance.now();
    const end = () => {
      one.times.push(performance.now() - start);
      going[kind]--;
    };
    return ask().then(
      value => {
        end();
        return value;
      },
      error => {
        end();
        one.failed++;
        throw error;
      },
    );
  };

  const tmdb = {
    search: (type, query, options) => timed("tmdbSearch", () => parts.tmdb.search(type, query, options)),
    title: (type, id) => timed("tmdbDetails", () => parts.tmdb.title(type, id)),
  };
  let providerSkipped = 0;
  const more = parts.createMoreMatches({
    tmdb: () => tmdb,
    imdbOfTmdb: (type, id) => parts.wikidata.imdbOf(type, id),
    details: (type, id) => timed("cinemetaDetails(tmdb)", () => app.cinemeta.meta(type, id)),
    providerTmdb: item => {
      if (!input.provider) {
        providerSkipped++;
        return Promise.resolve(undefined);
      }
      return timed("provider", () => app.vod.filmTmdb(item.film));
    },
  });

  const start = performance.now();
  let searchesDoneMs;
  let atSearchesEnd;
  let worstFrame = 0;
  let longFrames = 0;
  let last = performance.now();
  let watching = true;
  const frame = at => {
    const took = at - last;
    last = at;
    if (took > worstFrame) worstFrame = took;
    if (took > 100) longFrames++;
    if (watching) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const matcher = parts.createTitleMatcher({
    items: () => items,
    on: () => true,
    cinemetaUrl: () => `${app.cinemetaUrl()}#probe`,
    search: (type, title) =>
      timed(firstNames.has(title) ? "cinemetaSearch" : "cinemetaOtherName", () =>
        app.cinemeta.searchOrFail(type, uncached ? title.toLowerCase() : title),
      ),
    details: (type, id) => timed("cinemetaDetails", () => app.cinemeta.meta(type, id)),
    byTmdb: more.byTmdb,
    findMore: more.findMore,
    findMoreAtOnce: parts.MORE_AT_ONCE,
    concurrency: input.concurrency || 5,
    store: { load: async () => [], save: async () => {}, trim: async () => {} },
    saveEveryMs: 1e9,
  });

  const samples = [];
  const every = input.everyMs || 5000;
  let nextSample = every;
  const maxMs = input.maxMs || 300000;
  // Until it starts, then until it ends.
  for (let i = 0; i < 50 && !matcher.progress().running; i++) await sleep(100);
  while (performance.now() - start < maxMs) {
    await sleep(250);
    const p = matcher.progress();
    const ms = performance.now() - start;
    if (searchesDoneMs === undefined && p.total > 0 && p.done >= p.total) {
      searchesDoneMs = ms;
      const found = items.map(item => matcher.matchOf(item)).filter(Boolean);
      atSearchesEnd = { matched: found.length, partial: found.filter(match => match.partial).length };
    }
    if (ms >= nextSample) {
      nextSample += every;
      samples.push({
        s: Math.round(ms / 1000),
        done: p.done,
        waitingMore: p.waitingMore,
        waitingDetails: p.waitingDetails,
        going: { ...going },
      });
    }
    if (!p.running) break;
  }
  const allMs = performance.now() - start;
  watching = false;

  const median = values => {
    // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : 0;
  };
  const requests = {};
  let total = 0;
  for (const kind of Object.keys(kinds)) {
    const one = kinds[kind];
    const sum = one.times.reduce((a, b) => a + b, 0);
    total += one.times.length;
    requests[kind] = {
      count: one.times.length,
      failed: one.failed,
      medianMs: median(one.times),
      totalS: Math.round(sum / 100) / 10,
      // How many were going at once, on average over the whole run.
      atOnce: Math.round((sum / allMs) * 10) / 10,
    };
  }
  const via = {};
  let matched = 0;
  for (const item of items) {
    const match = matcher.matchOf(item);
    const how = match ? match.via || "name" : "none";
    via[how] = (via[how] || 0) + 1;
    if (match) matched++;
  }
  return {
    films: items.length,
    uncached,
    concurrency: input.concurrency || 5,
    searchesS: searchesDoneMs === undefined ? null : Math.round(searchesDoneMs / 100) / 10,
    atSearchesEnd,
    allS: Math.round(allMs / 100) / 10,
    filmsPerSecond: Math.round((items.length / (allMs / 1000)) * 10) / 10,
    matched,
    via,
    requests,
    requestsPerFilm: Math.round((total / items.length) * 100) / 100,
    providerSkipped,
    frames: { worstMs: Math.round(worstFrame), over100ms: longFrames },
    samples,
  };
}
