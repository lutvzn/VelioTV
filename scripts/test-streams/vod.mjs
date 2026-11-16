// Made-up films and series for testing Movies and Series (PLAN.md, Phase 6):
// for the mock Xtream API (xtream.mjs), its get.php playlist, and the plain
// playlist with ?vod=1 (playlist.mjs). As with the channels, fixed seeds
// make the same counts always give the same data.
//
// Every film and episode plays the same made-up film (server.mjs, /vod/),
// so each says it lasts as long as that does.

import { hash, random } from "./catalog.mjs";

export const FILM_SECONDS = 360;

const GENRES = [
  "Action",
  "Comedy",
  "Drama",
  "Documentary",
  "Family",
  "Horror",
  "Science fiction",
  "Thriller",
];
const SYLLABLES = "ka lo mi ra ven tor sil bri dun mar pel quo zan fe rin tal gor nu bel cas".split(" ");
const capital = word => word[0].toUpperCase() + word.slice(1);
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const word = rand => {
  let text = "";
  for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) text += pick(rand, SYLLABLES);
  return text;
};
const title = (rand, words) => Array.from({ length: words }, () => capital(word(rand))).join(" ");
const sentence = (rand, words) => {
  const list = Array.from({ length: words }, () => word(rand));
  list[0] = capital(list[0]);
  return `${list.join(" ")}.`;
};
const people = rand => Array.from({ length: 3 }, () => `${capital(word(rand))} ${capital(word(rand))}`);
// Some films have no poster, as on real servers.
const hasPoster = id => id % 17 !== 0;
const CONTAINERS = ["mp4", "mp4", "mkv", "mp4", "ts"];

const buildFilms = (count, channels) =>
  Array.from({ length: count }, (_, i) => {
    const id = 10_000 + i;
    const rand = random(hash(`film-${id}`));
    const year = 1970 + Math.floor(rand() * 56);
    const genreId = Math.floor(rand() * GENRES.length);
    return {
      id,
      name: `${title(rand, 1 + Math.floor(rand() * 3))} (${year})`,
      year,
      genreId,
      genre: GENRES[genreId],
      rating: Math.round((4 + rand() * 5.5) * 10) / 10,
      plot: `${sentence(rand, 12 + Math.floor(rand() * 20))} ${sentence(rand, 8 + Math.floor(rand() * 10))}`,
      cast: people(rand),
      director: `${capital(word(rand))} ${capital(word(rand))}`,
      container: CONTAINERS[id % CONTAINERS.length],
      poster: hasPoster(id) ? `/poster/${channels}/film/${id}.svg` : null,
      added: 1_767_225_600 + i * 3600,
    };
  });

const buildSeries = (count, channels) => {
  let episodeId = 50_000;
  return Array.from({ length: count }, (_, i) => {
    const id = 1000 + i;
    const rand = random(hash(`series-${id}`));
    const genreId = Math.floor(rand() * GENRES.length);
    const year = 1990 + Math.floor(rand() * 36);
    const seasons = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_season, s) =>
      Array.from({ length: 4 + Math.floor(rand() * 5) }, (_episode, e) => ({
        id: episodeId++,
        season: s + 1,
        episode: e + 1,
        title: title(rand, 1 + Math.floor(rand() * 3)),
        plot: sentence(rand, 10 + Math.floor(rand() * 14)),
        container: e % 3 === 2 ? "mkv" : "mp4",
      })),
    );
    return {
      id,
      name: title(rand, 1 + Math.floor(rand() * 2)),
      year,
      genreId,
      genre: GENRES[genreId],
      rating: Math.round((5 + rand() * 4.5) * 10) / 10,
      plot: `${sentence(rand, 14 + Math.floor(rand() * 16))} ${sentence(rand, 8 + Math.floor(rand() * 8))}`,
      cast: people(rand),
      director: `${capital(word(rand))} ${capital(word(rand))}`,
      poster: `/poster/${channels}/series/${id}.svg`,
      seasons,
    };
  });
};

const libraries = new Map();

/**
 * Films and series: about one film per 8 channels and one series per 150, at
 * least 24 and 6, unless `films` and `series` give the counts.
 */
/** The made-up TMDB ids Xtream gives, which the made-up Wikidata (stremio.mjs) knows. */
export const filmTmdb = id => 100_000 + id;
export const seriesTmdb = id => 200_000 + id;

export const vodLibrary = (channelCount, { films, series } = {}) => {
  const filmCount = films ?? Math.max(24, Math.min(2000, Math.round(channelCount / 8)));
  const seriesCount = series ?? Math.max(6, Math.min(80, Math.round(channelCount / 150)));
  const key = `${channelCount}/${filmCount}/${seriesCount}`;
  if (!libraries.has(key)) {
    libraries.set(key, {
      films: buildFilms(filmCount, channelCount),
      series: buildSeries(seriesCount, channelCount),
      genres: GENRES,
    });
  }
  return libraries.get(key);
};

export const findEpisode = (library, id) => {
  for (const show of library.series) {
    for (const season of show.seasons) {
      const episode = season.find(one => one.id === id);
      if (episode) return { show, episode };
    }
  }
  return undefined;
};

const pad = n => String(n).padStart(2, "0");
export const episodeCode = episode => `S${pad(episode.season)} E${pad(episode.episode)}`;
const duration = () => `00:${pad(Math.floor(FILM_SECONDS / 60))}:${pad(FILM_SECONDS % 60)}`;

// The film's subtitles as a separate file, as subtitle add-ons give them:
// one a second, for 800 ms, saying its format and the time the film's clock
// shows then, such as "SRT 0:01:05", so a TV test can check they keep time.
export const filmSubtitles = format => {
  const time = (seconds, ms) => {
    const sep = format === "srt" ? "," : ".";
    return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}${sep}${ms}`;
  };
  const label = format.toUpperCase();
  const cues = Array.from({ length: FILM_SECONDS }, (_, s) => {
    const clock = `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    const cue = `${time(s, "000")} --> ${time(s, "800")}\n${label} ${clock}\n`;
    return format === "srt" ? `${s + 1}\n${cue}` : cue;
  });
  return `${format === "vtt" ? "WEBVTT\n\n" : ""}${cues.join("\n")}`;
};

// The Xtream API's answers (player_api.php actions).
// What the server found when it looked into a file: panels give `video` and
// `bitrate` (kbps) once they have, and `[]` and 0 when not. Made up: the files
// are the test streams.
const PICTURES = [
  { width: 3840, height: 1608, bitrate: 18_000 },
  { width: 1920, height: 1080, bitrate: 6000 },
  { width: 1280, height: 720, bitrate: 2800 },
  undefined,
];
export const probed = id => {
  const picture = PICTURES[id % PICTURES.length];
  return picture
    ? {
        video: { codec_name: "h264", width: picture.width, height: picture.height },
        bitrate: picture.bitrate,
      }
    : { video: [], bitrate: 0 };
};

export const xtreamVod = {
  categories: library =>
    library.genres.map((name, id) => ({ category_id: String(id + 1), category_name: name, parent_id: 0 })),

  films: (library, base, category) =>
    library.films
      .filter(film => !category || String(film.genreId + 1) === category)
      .map((film, at) => ({
        num: at + 1,
        name: film.name,
        stream_type: "movie",
        stream_id: film.id,
        stream_icon: film.poster ? `${base}${film.poster}` : "",
        rating: String(film.rating),
        rating_5based: Math.round(film.rating * 5) / 10,
        added: String(film.added),
        category_id: String(film.genreId + 1),
        container_extension: film.container,
        custom_sid: "",
        direct_source: "",
      })),

  filmInfo: (library, base, id) => {
    const film = library.films.find(one => one.id === id);
    if (!film) return { info: [], movie_data: [] };
    return {
      info: {
        tmdb_id: String(filmTmdb(film.id)),
        movie_image: film.poster ? `${base}${film.poster}` : "",
        // Films with a poster have a backdrop too; real servers often send none.
        backdrop_path: film.poster ? [`${base}${backdropPath(film.poster)}`] : [],
        name: film.name,
        plot: film.plot,
        cast: film.cast.join(", "),
        director: film.director,
        genre: film.genre,
        releasedate: `${film.year}-06-01`,
        duration_secs: FILM_SECONDS,
        duration: duration(),
        rating: String(film.rating),
        ...probed(film.id),
      },
      movie_data: {
        stream_id: film.id,
        name: film.name,
        added: String(film.added),
        category_id: String(film.genreId + 1),
        container_extension: film.container,
      },
    };
  },

  series: (library, base, category) =>
    library.series
      .filter(show => !category || String(show.genreId + 1) === category)
      .map((show, at) => ({
        num: at + 1,
        name: show.name,
        series_id: show.id,
        tmdb_id: String(seriesTmdb(show.id)),
        cover: `${base}${show.poster}`,
        plot: show.plot,
        cast: show.cast.join(", "),
        director: show.director,
        genre: show.genre,
        releaseDate: `${show.year}-01-01`,
        last_modified: String(1_767_225_600 + show.id * 7200),
        rating: String(show.rating),
        rating_5based: Math.round(show.rating * 5) / 10,
        category_id: String(show.genreId + 1),
      })),

  seriesInfo: (library, base, id) => {
    const show = library.series.find(one => one.id === id);
    if (!show) return { seasons: [], info: [], episodes: [] };
    return {
      seasons: show.seasons.map((episodes, at) => ({
        season_number: at + 1,
        name: `Season ${at + 1}`,
        episode_count: String(episodes.length),
        cover: `${base}${show.poster}`,
      })),
      info: {
        name: show.name,
        cover: `${base}${show.poster}`,
        backdrop_path: [`${base}${backdropPath(show.poster)}`],
        plot: show.plot,
        cast: show.cast.join(", "),
        director: show.director,
        genre: show.genre,
        releaseDate: `${show.year}-01-01`,
        rating: String(show.rating),
      },
      episodes: Object.fromEntries(
        show.seasons.map((episodes, at) => [
          String(at + 1),
          episodes.map(episode => ({
            id: String(episode.id),
            episode_num: episode.episode,
            title: `${show.name} - ${episodeCode(episode)} - ${episode.title}`,
            container_extension: episode.container,
            season: episode.season,
            info: {
              plot: episode.plot,
              duration_secs: FILM_SECONDS,
              duration: duration(),
              ...probed(episode.id),
            },
          })),
        ]),
      ),
    };
  },
};

const attribute = value => String(value).replaceAll('"', "'");

/**
 * The playlist lines for the films and episodes, as Xtream panels list them
 * in get.php (`url` gives Xtream-style /movie/ and /series/ URLs), or as a
 * plain playlist might, with video files.
 */
export const vodLines = (library, base, url) => {
  const lines = [];
  for (const film of library.films) {
    lines.push(
      `#EXTINF:-1 tvg-id="" tvg-name="${attribute(film.name)}" tvg-logo="${film.poster ? `${base}${film.poster}` : ""}" group-title="Movies: ${film.genre}",${film.name}`,
      url("movie", film.id, film.container),
    );
  }
  for (const show of library.series) {
    for (const season of show.seasons) {
      for (const episode of season) {
        const name = `${show.name} ${episodeCode(episode)}`;
        lines.push(
          `#EXTINF:-1 tvg-id="" tvg-name="${attribute(name)}" tvg-logo="${base}${show.poster}" group-title="Series: ${show.genre}",${name}`,
          url("series", episode.id, episode.container),
        );
      }
    }
  }
  return lines;
};

const escapeXml = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The backdrop's address for a poster's: /poster/... becomes /backdrop/.... */
const backdropPath = poster => poster.replace(/^\/poster\//, "/backdrop/");

/**
 * A backdrop: a wide 16:9 picture in the poster's colours, with soft shapes
 * and no title, as a still from a film would have.
 */
export const backdropSvg = (library, kind, id) => {
  const item = (kind === "film" ? library.films : library.series).find(one => one.id === id);
  if (!item) return undefined;
  const hue = hash(item.name) % 360;
  const other = (hue + 40) % 360;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${other} 60% 16%)"/><stop offset="1" stop-color="hsl(${hue} 55% 38%)"/></linearGradient>`,
    `<radialGradient id="r" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="hsl(${hue} 70% 70%)" stop-opacity="0.55"/><stop offset="1" stop-color="hsl(${hue} 70% 70%)" stop-opacity="0"/></radialGradient></defs>`,
    `<rect width="1280" height="720" fill="url(#g)"/>`,
    `<circle cx="${880 + (hash(item.name + "x") % 200)}" cy="${220 + (hash(item.name + "y") % 200)}" r="360" fill="url(#r)"/>`,
    `<path d="M0 560 L320 420 L560 520 L860 360 L1280 520 L1280 720 L0 720 Z" fill="hsl(${other} 50% 10%)" fill-opacity="0.7"/>`,
    `<text x="1240" y="680" font-family="sans-serif" font-size="28" fill="#ffffff80" text-anchor="end">${kind === "film" ? "Film" : "Series"} ${id}</text>`,
    `</svg>`,
  ].join("");
};

/** A poster: a coloured 2:3 card with the title on it. */
export const posterSvg = (library, kind, id) => {
  const item = (kind === "film" ? library.films : library.series).find(one => one.id === id);
  if (!item) return undefined;
  const hue = hash(item.name) % 360;
  const words = item.name.split(" ");
  const lines = [];
  for (const one of words) {
    const last = lines[lines.length - 1];
    if (last && `${last} ${one}`.length <= 12) lines[lines.length - 1] = `${last} ${one}`;
    else lines.push(one);
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 45%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 60% 18%)"/></linearGradient></defs>`,
    `<rect width="400" height="600" fill="url(#g)"/>`,
    ...lines
      .slice(0, 4)
      .map(
        (line, at) =>
          `<text x="200" y="${230 + at * 64}" font-family="sans-serif" font-size="52" font-weight="bold" fill="#fff" text-anchor="middle">${escapeXml(line)}</text>`,
      ),
    `<text x="200" y="560" font-family="sans-serif" font-size="30" fill="#ffffffcc" text-anchor="middle">${kind === "film" ? "Film" : "Series"} ${id}</text>`,
    `</svg>`,
  ].join("");
};
