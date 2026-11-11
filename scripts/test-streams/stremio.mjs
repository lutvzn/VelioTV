// A made-up Stremio add-on (PLAN.md, "Stremio add-ons", step 7), over the
// test server's films and series (vod.mjs), which all play its one test
// film. Add it to the mock Velio account with
// /sync/add-list?kind=stremio&profiles=Living%20room, or to Stremio itself
// by its manifest's address:
//   /stremio/manifest.json
//   /stremio/catalog/(movie|series)/<catalog>[/skip=<n>|/search=<text>].json
//   /stremio/meta/(movie|series)/<id>.json
//   /stremio/stream/(movie|series)/<id>.json
//   /stremio/subtitles/(movie|series)/<id>.json
// Ids look like IMDb's, as most add-ons' do, so the modern Movies and
// Series join them with the sources' copies (PLAN.md, "Movies and Series by
// title"): films are "tt00<id>", series "tt09<id>" and episodes
// "tt09<id>:<season>:<episode>".
//
// A made-up Cinemeta has the same titles' details, for matching the
// sources' films and series to:
//   /cinemeta/manifest.json
//   /cinemeta/catalog/(movie|series)/top[/skip=<n>|/search=<text>].json
//   /cinemeta/meta/(movie|series)/<id>.json
// It leaves out every film whose id divides by 11, and every fifth series,
// so some stay in their provider's category, and gives every film whose id
// divides by 7 a year one later, as the two often disagree. Its search
// doesn't find films whose id divides by 13 or series by 3, which only
// their TMDB id finds, through a made-up Wikidata:
//   /wikidata/sparql?query=<SPARQL>
// It knows each TMDB id Xtream gives (vod.mjs) but those of films whose id
// divides by 17. A made-up TMDB knows every title Cinemeta has, so it
// finds those its search doesn't; films Cinemeta leaves out it has with no
// IMDb id, so they stay in their category:
//   /tmdb/3/search/(movie|tv)?query=<text>[&year=<y>|&first_air_date_year=<y>]
//   /tmdb/3/(movie|tv)/<tmdb id>?append_to_response=external_ids
// Any api_key works.
// Each film and episode has an MP4 stream and an HLS one, each with its
// own binge group, and the MP4 one has the film's SRT subtitles; the
// subtitles resource gives its VTT ones. The second film has only streams
// the TV can't play: a torrent, and one that needs a Referer.

import { FILM_SECONDS, filmTmdb, seriesTmdb, vodLibrary } from "./vod.mjs";

/** The channel count the library is made for: 60 films and 6 series, with posters. */
const CHANNELS = 480;
/** Titles per catalog page, so paging is tried. */
const PAGE = 20;

const library = () => vodLibrary(CHANNELS);

const manifest = {
  id: "tv.velio.test",
  version: "1.0.0",
  name: "Velio test add-on",
  description: "Made-up films and series for testing Velio.",
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  resources: ["catalog", "meta", "stream", "subtitles"],
  catalogs: [
    {
      type: "movie",
      id: "films",
      name: "Test films",
      extra: [{ name: "skip" }, { name: "search" }],
    },
    { type: "series", id: "shows", name: "Test series", extra: [{ name: "search" }] },
    // Only a genre picks from it, which the app leaves out.
    {
      type: "movie",
      id: "by-genre",
      name: "By genre",
      extra: [{ name: "genre", isRequired: true, options: ["Drama"] }],
    },
  ],
};

export const filmImdb = id => `tt00${id}`;
export const seriesImdb = id => `tt09${String(id).padStart(5, "0")}`;
/** The name without the year, which the sources put after it. */
const plainName = name => name.replace(/\s*\(\d{4}\)$/, "");

const filmMeta = (film, base, full) => ({
  id: filmImdb(film.id),
  type: "movie",
  name: plainName(film.name),
  ...(film.poster ? { poster: `${base}${film.poster}` } : {}),
  releaseInfo: String(film.year),
  imdbRating: film.rating.toFixed(1),
  genres: [film.genre],
  ...(full
    ? {
        description: film.plot,
        cast: [film.cast].flat(),
        director: [film.director],
        runtime: `${Math.round(FILM_SECONDS / 60)} min`,
        ...(film.poster ? { background: `${base}${film.poster.replace(/^\/poster\//, "/backdrop/")}` } : {}),
      }
    : {}),
});

const seriesMeta = (show, base, full) => ({
  id: seriesImdb(show.id),
  type: "series",
  name: show.name,
  poster: `${base}${show.poster}`,
  releaseInfo: `${show.year}-`,
  imdbRating: show.rating.toFixed(1),
  genres: [show.genre],
  description: show.plot,
  ...(full
    ? {
        cast: [show.cast].flat(),
        background: `${base}${show.poster.replace(/^\/poster\//, "/backdrop/")}`,
        videos: show.seasons.flat().map(episode => ({
          id: `${seriesImdb(show.id)}:${episode.season}:${episode.episode}`,
          season: episode.season,
          episode: episode.episode,
          title: episode.title,
          overview: episode.plot,
        })),
      }
    : {}),
});

const matches = (name, search) => name.toLowerCase().includes(search.toLowerCase());

/** The extras in a catalog's path, such as "skip=20" or "search=big%20film". */
const readExtra = text => Object.fromEntries(new URLSearchParams(text ?? "").entries());

const catalog = (type, id, extraText, base) => {
  const extra = readExtra(extraText);
  const { films, series } = library();
  if (type === "movie" && id === "films") {
    const found = extra.search ? films.filter(film => matches(film.name, extra.search)) : films;
    const skip = Number(extra.skip) || 0;
    return { metas: found.slice(skip, skip + PAGE).map(film => filmMeta(film, base, false)) };
  }
  if (type === "series" && id === "shows") {
    const found = extra.search ? series.filter(show => matches(show.name, extra.search)) : series;
    return { metas: found.map(show => seriesMeta(show, base, false)) };
  }
  if (type === "movie" && id === "by-genre") {
    return {
      metas: films.filter(film => film.genre === extra.genre).map(film => filmMeta(film, base, false)),
    };
  }
  return undefined;
};

const filmOf = id => library().films.find(film => filmImdb(film.id) === id);
const seriesOf = id => library().series.find(show => seriesImdb(show.id) === id);

const meta = (type, id, base) => {
  if (type === "movie") {
    const film = filmOf(id);
    return film ? { meta: filmMeta(film, base, true) } : undefined;
  }
  const show = seriesOf(id);
  return show ? { meta: seriesMeta(show, base, true) } : undefined;
};

/** The streams for a film, or an episode named "S01 E02". */
const testStreams = (base, label, unplayable) =>
  unplayable
    ? [
        {
          name: "Velio test\nTorrent",
          description: `${label}\nA torrent, which the TV can't play`,
          infoHash: "0123456789abcdef0123456789abcdef01234567",
          fileIdx: 0,
        },
        {
          name: "Velio test\nReferer",
          description: `${label}\nNeeds a Referer`,
          url: `${base}/need-referer/vod/film.mp4`,
          behaviorHints: { proxyHeaders: { request: { Referer: `${base}/` } } },
        },
      ]
    : [
        {
          name: "Velio test\nMP4",
          description: `${label}\nMP4, with SRT subtitles`,
          url: `${base}/vod/film.mp4`,
          behaviorHints: { bingeGroup: "velio-test-mp4" },
          subtitles: [{ id: "srt", url: `${base}/vod/film.srt`, lang: "eng" }],
        },
        {
          name: "Velio test\nHLS",
          description: `${label}\nHLS`,
          url: `${base}/vod/film.m3u8`,
          behaviorHints: { bingeGroup: "velio-test-hls" },
        },
      ];

const streams = (type, id, base) => {
  if (type === "movie") {
    const film = filmOf(id);
    if (!film) return { streams: [] };
    const second = library().films[1] === film;
    return { streams: testStreams(base, film.name, second) };
  }
  const [showId, season, episode] = id.split(":");
  const show = seriesOf(showId);
  if (!show || !season || !episode) return { streams: [] };
  const code = `S${season.padStart(2, "0")} E${episode.padStart(2, "0")}`;
  return { streams: testStreams(base, `${show.name} ${code}`, false) };
};

const subtitles = (type, id, base) => {
  const known = type === "movie" ? filmOf(id) : seriesOf(id.split(":")[0]);
  // The VTT file under Portuguese, so it's a second language to choose.
  return { subtitles: known ? [{ id: "vtt", url: `${base}/vod/film.vtt`, lang: "por" }] : [] };
};

/** Answers the add-on's requests; false for other paths. */
export const handleStremio = (res, url, base, send) => {
  if (!url.pathname.startsWith("/stremio/")) return false;
  const json = value =>
    value === undefined
      ? send(res, 404, '{"error":"Not found"}', "application/json")
      : send(res, 200, JSON.stringify(value), "application/json");
  const addonBase = `${base}`;
  if (url.pathname === "/stremio/manifest.json") return (json(manifest), true);
  const parts = url.pathname.match(
    /^\/stremio\/(catalog|meta|stream|subtitles)\/(movie|series)\/([^/]+?)(?:\/([^/]+?))?\.json$/,
  );
  if (!parts) return (json(undefined), true);
  const [, resource, type, rawId, extra] = parts;
  const id = decodeURIComponent(rawId);
  if (resource === "catalog") return (json(catalog(type, id, extra, addonBase)), true);
  if (resource === "meta") return (json(meta(type, id, addonBase)), true);
  if (resource === "stream") return (json(streams(type, id, addonBase)), true);
  return (json(subtitles(type, id, addonBase)), true);
};

// The made-up Cinemeta, over every film and series the test server makes.

/** The most the server makes: 2,000 films and 80 series. */
const ALL = 16_000;
const CINEMETA_PAGE = 50;
const cinemetaManifest = {
  id: "tv.velio.test.cinemeta",
  version: "1.0.0",
  name: "Cinemeta (Velio test)",
  description: "Made-up details of the test server's films and series.",
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  resources: ["catalog", "meta"],
  catalogs: [
    {
      type: "movie",
      id: "top",
      name: "Popular",
      extra: [{ name: "skip" }, { name: "search" }, { name: "genre" }],
    },
    {
      type: "series",
      id: "top",
      name: "Popular",
      extra: [{ name: "skip" }, { name: "search" }, { name: "genre" }],
    },
  ],
};

const known = () => {
  const { films, series } = vodLibrary(ALL);
  return {
    films: films.filter(film => film.id % 11 !== 0),
    series: series.filter(show => show.id % 5 !== 0),
  };
};
/** A second genre, so a title shows in two. */
const genresOf = item => {
  const second = GENRES_FOR_CINEMETA[(item.genreId + 3) % GENRES_FOR_CINEMETA.length];
  return item.id % 2 === 0 ? [item.genre, second] : [item.genre];
};
const GENRES_FOR_CINEMETA = vodLibrary(ALL).genres;

const cinemetaFilm = (film, base, full) => {
  const year = film.id % 7 === 0 ? film.year + 1 : film.year;
  return {
    ...filmMeta(film, base, full),
    poster: `${base}/poster/${ALL}/film/${film.id}.svg`,
    releaseInfo: String(year),
    year,
    genres: genresOf(film),
  };
};
const cinemetaSeries = (show, base, full) => ({
  ...seriesMeta(show, base, full),
  poster: `${base}/poster/${ALL}/series/${show.id}.svg`,
  genres: genresOf(show),
});

/** Popular: by rating, highest first. */
const popular = list =>
  // oxlint-disable-next-line unicorn/no-array-sort
  [...list].sort((a, b) => b.rating - a.rating || a.id - b.id);

const cinemetaCatalog = (type, extraText, base) => {
  const extra = readExtra(extraText);
  const { films, series } = known();
  const list = type === "movie" ? films : series;
  const toMeta = type === "movie" ? cinemetaFilm : cinemetaSeries;
  const unsearched = type === "movie" ? 13 : 3;
  const found = extra.search
    ? list.filter(item => item.id % unsearched !== 0 && matches(plainName(item.name), extra.search))
    : popular(extra.genre ? list.filter(item => genresOf(item).includes(extra.genre)) : list);
  const skip = Number(extra.skip) || 0;
  return { metas: found.slice(skip, skip + CINEMETA_PAGE).map(item => toMeta(item, base, false)) };
};

const cinemetaMeta = (type, id, base) => {
  const { films, series } = known();
  if (type === "movie") {
    const film = films.find(one => filmImdb(one.id) === id);
    return film ? { meta: cinemetaFilm(film, base, true) } : { meta: null };
  }
  const show = series.find(one => seriesImdb(one.id) === id);
  return show ? { meta: cinemetaSeries(show, base, true) } : { meta: null };
};

/** The made-up Wikidata's answer to the app's query: the IMDb id for each TMDB id it knows. */
const wikidataAnswer = query => {
  const { films, series } = known();
  const isFilm = query.includes("wdt:P4947");
  const byTmdb = new Map(
    isFilm
      ? films.filter(film => film.id % 17 !== 0).map(film => [String(filmTmdb(film.id)), filmImdb(film.id)])
      : series.map(show => [String(seriesTmdb(show.id)), seriesImdb(show.id)]),
  );
  const values = /VALUES \?tmdb \{([^}]*)\}/.exec(query)?.[1] ?? "";
  const bindings = [];
  for (const [, tmdb] of values.matchAll(/"(\d+)"/g)) {
    const imdb = byTmdb.get(tmdb);
    if (imdb)
      bindings.push({ tmdb: { type: "literal", value: tmdb }, imdb: { type: "literal", value: imdb } });
  }
  return { head: { vars: ["tmdb", "imdb"] }, results: { bindings } };
};

/** Answers the made-up Wikidata's SPARQL; false for other paths. */
export const handleWikidata = (res, url, send) => {
  if (url.pathname !== "/wikidata/sparql") return false;
  send(res, 200, JSON.stringify(wikidataAnswer(url.searchParams.get("query") ?? "")), "application/json");
  return true;
};

/** Answers the made-up Cinemeta's requests; false for other paths. */
export const handleCinemeta = (res, url, base, send) => {
  if (!url.pathname.startsWith("/cinemeta/")) return false;
  const json = value =>
    value === undefined
      ? send(res, 404, '{"error":"Not found"}', "application/json")
      : send(res, 200, JSON.stringify(value), "application/json");
  if (url.pathname === "/cinemeta/manifest.json") return (json(cinemetaManifest), true);
  const parts = url.pathname.match(
    /^\/cinemeta\/(catalog|meta)\/(movie|series)\/([^/]+?)(?:\/([^/]+?))?\.json$/,
  );
  if (!parts) return (json(undefined), true);
  const [, resource, type, rawId, extra] = parts;
  const id = decodeURIComponent(rawId);
  if (resource === "catalog")
    return (json(id === "top" ? cinemetaCatalog(type, extra, base) : undefined), true);
  return (json(cinemetaMeta(type, id, base)), true);
};

// The made-up TMDB, over every film and series the test server makes.

const TMDB_PAGE = 20;
const tmdbDate = year => `${year}-06-01`;

const tmdbFound = (type, item) =>
  type === "movie"
    ? {
        id: filmTmdb(item.id),
        title: plainName(item.name),
        original_title: plainName(item.name),
        release_date: tmdbDate(item.year),
      }
    : {
        id: seriesTmdb(item.id),
        name: plainName(item.name),
        original_name: plainName(item.name),
        first_air_date: tmdbDate(item.year),
      };

const tmdbSearch = (type, params) => {
  const { films, series } = vodLibrary(ALL);
  const list = type === "movie" ? films : series;
  const query = params.get("query") ?? "";
  const year = Number(params.get(type === "movie" ? "year" : "first_air_date_year")) || undefined;
  const found = list.filter(
    item => matches(plainName(item.name), query) && (year === undefined || item.year === year),
  );
  return {
    page: 1,
    results: found.slice(0, TMDB_PAGE).map(item => tmdbFound(type, item)),
    total_results: found.length,
  };
};

const tmdbTitle = (type, id) => {
  const { films, series } = vodLibrary(ALL);
  const item =
    type === "movie"
      ? films.find(film => filmTmdb(film.id) === id)
      : series.find(show => seriesTmdb(show.id) === id);
  if (!item) return undefined;
  const imdb =
    type === "movie"
      ? item.id % 11 === 0
        ? null
        : filmImdb(item.id)
      : item.id % 5 === 0
        ? null
        : seriesImdb(item.id);
  return {
    ...tmdbFound(type, item),
    genres: genresOf(item).map((name, i) => ({ id: i + 1, name })),
    poster_path: null,
    ...(type === "movie" ? { imdb_id: imdb } : {}),
    external_ids: { imdb_id: imdb },
  };
};

/** Answers the made-up TMDB's requests; false for other paths. */
export const handleTmdb = (res, url, send) => {
  if (!url.pathname.startsWith("/tmdb/3/")) return false;
  const json = value =>
    value === undefined
      ? send(res, 404, '{"success":false,"status_code":34}', "application/json")
      : send(res, 200, JSON.stringify(value), "application/json");
  const search = /^\/tmdb\/3\/search\/(movie|tv)$/.exec(url.pathname);
  if (search) return (json(tmdbSearch(search[1] === "movie" ? "movie" : "series", url.searchParams)), true);
  const title = /^\/tmdb\/3\/(movie|tv)\/(\d+)$/.exec(url.pathname);
  return (
    json(title ? tmdbTitle(title[1] === "movie" ? "movie" : "series", Number(title[2])) : undefined), true
  );
};
