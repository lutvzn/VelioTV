// How fast Cinemeta's and TMDB's searches answer from the TV, and how many
// requests at once each takes (PLAN.md, "Movies and Series by title"). Film
// names from the sources, cleaned as matching cleans them, are searched on
// both, the same names on each, at each number of requests at once; each
// number gets names of its own, so earlier answers aren't asked again. For
// each, it reports the requests a second, how long they took (median, 90th
// percentile, longest), the errors by kind, and whether the answers came
// from a cache, where the server says. About 2 minutes. Needs the build's
// TMDB key (TMDB_API_KEY in .env).
//
// Input, all optional:
//   "levels": [1, 4, 8, 16, 32]   requests at once
//   "each": 6                     names per request at once (at least 16 a level)
//   "timeoutMs": 15000
//   "uncached": false             names in lower case, which caches haven't
//                                  seen (the matcher asks as written), for a new source's speed
//   "services": ["cinemeta", "tmdb"]
//   "offset": 0                   from 0 to 1: which films are taken, so a run
//                                  can search names an earlier one didn't

async function probe(input) {
  const app = window.velio;
  const levels = input.levels || [1, 4, 8, 16, 32];
  const each = input.each || 6;
  const timeoutMs = input.timeoutMs || 15000;
  const asName = name => (input.uncached ? name.toLowerCase() : name);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  if (!app.tmdbOn()) return { error: "This build has no TMDB key" };
  for (let i = 0; i < 100 && app.vod.films().length === 0; i++) await sleep(200);

  // Different names, spread over the sources' films.
  const seen = new Set();
  const names = [];
  const films = app.vod.films();
  const wanted = levels.reduce((sum, level) => sum + Math.max(16, level * each), 0);
  const step = Math.max(1, Math.floor(films.length / (wanted * 2)));
  for (let i = Math.floor((input.offset || 0) * step); i < films.length && names.length < wanted; i += step) {
    const { title } = app.cleanTitle(films[i].name, films[i].year);
    const key = app.nameKey(title);
    if (title.length < 2 || seen.has(key)) continue;
    seen.add(key);
    names.push(asName(title));
  }

  const CINEMETA = "https://v3-cinemeta.strem.io";
  const services = {
    cinemeta: name => fetch(`${CINEMETA}/catalog/movie/top/search=${encodeURIComponent(name)}.json`),
    tmdb: name => app.tmdbRequest(`/search/movie?query=${encodeURIComponent(name)}`),
  };

  const ask = async (service, name) => {
    const start = performance.now();
    try {
      const response = await Promise.race([
        services[service](name),
        sleep(timeoutMs).then(() => {
          throw new Error("timeout");
        }),
      ]);
      const body = await response.json();
      const results = Array.isArray(body.metas)
        ? body.metas.length
        : Array.isArray(body.results)
          ? body.results.length
          : 0;
      const cache = response.headers.get("cf-cache-status") || response.headers.get("x-cache") || "";
      return { ms: performance.now() - start, status: response.status, results, cache };
    } catch (error) {
      return { ms: performance.now() - start, error: String(error && error.message ? error.message : error) };
    }
  };

  const run = async (service, list, atOnce) => {
    const answers = [];
    let next = 0;
    const start = performance.now();
    const worker = async () => {
      while (next < list.length) answers.push(await ask(service, list[next++]));
    };
    await Promise.all(Array.from({ length: atOnce }, worker));
    const wall = performance.now() - start;
    // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
    const times = answers.map(one => one.ms).sort((a, b) => a - b);
    const at = part => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * part))]);
    const errors = {};
    const caches = {};
    const byCache = {};
    for (const one of answers) {
      const kind = one.error || (one.status >= 400 ? `HTTP ${one.status}` : "");
      if (kind) errors[kind] = (errors[kind] || 0) + 1;
      if (one.cache) caches[one.cache] = (caches[one.cache] || 0) + 1;
      (byCache[one.cache || "none"] = byCache[one.cache || "none"] || []).push(one.ms);
    }
    // The median time of the answers from a cache, and of those not.
    const medianOf = values => {
      // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
      const sorted = values.slice().sort((a, b) => a - b);
      return Math.round(sorted[Math.floor(sorted.length / 2)]);
    };
    const medianByCache = {};
    for (const kind of Object.keys(byCache)) medianByCache[kind] = medianOf(byCache[kind]);
    return {
      atOnce,
      asked: list.length,
      perSecond: Math.round((list.length / wall) * 10000) / 10,
      medianMs: at(0.5),
      p90Ms: at(0.9),
      worstMs: Math.round(times[times.length - 1]),
      errors,
      caches,
      medianByCache,
      withResults: answers.filter(one => one.results > 0).length,
    };
  };

  const out = {
    names: names.length,
    matching: app.titleMatcher.progress().running,
    cinemeta: [],
    tmdb: [],
  };
  let from = 0;
  for (const level of levels) {
    const list = names.slice(from, from + Math.max(16, level * each));
    from += list.length;
    console.log("[probe]", `${level} at once, ${list.length} names`);
    // Each service in turn, the same names, so both see the same network.
    for (const service of input.services || ["cinemeta", "tmdb"]) {
      out[service].push(await run(service, list, level));
      await sleep(1000);
    }
  }
  return out;
}
