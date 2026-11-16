#!/usr/bin/env node
// Serves live test streams, for checking which formats a TV plays, and made-up
// sources (playlists, guides and logins) that play them. Requires ffmpeg with libx264 and libx265:
//
//   node scripts/test-streams/server.mjs [--port 8090] [--channels 10000] [--days 7]
//
// The first run encodes a 20-second clip per stream, which takes a few
// minutes; later runs reuse them. Each clip then loops live, as:
//   /ts/<id>.ts                  raw MPEG-TS over HTTP
//   /hls/<id>/index.m3u8         HLS
// The h264-tracks stream has two audio tracks, and over HLS, subtitles in
// two languages.
// Under /need-referer/ and /need-user-agent/, the same paths only answer
// requests with the right header, to test streams that need custom headers.
// Under /fail/, they fail on purpose, to test reconnecting:
//   /fail/cut/<seconds>/ts/<id>.ts    drops the connection after that long
//   /fail/stall/<seconds>/ts/<id>.ts  stops sending after that long, but
//                                     keeps the connection open
//   /fail/status/<code>/...           answers with that HTTP status
//   /fail/outage/...                  plays, except during an outage, when
//                                     it is cut off and refused (503)
//   /fail/outage?seconds=<n>          starts an outage of n seconds;
//                                     with &hang=1, streams stop sending and
//                                     new requests get no answer instead
//
// The sources (see catalog.mjs) have --channels channels and --days days of
// guide, starting yesterday; ?channels= and ?days= change them per request:
//   /playlist.m3u                M3U playlist
//   /guide.xml                   XMLTV guide, generated as it is sent
//   /guide.xml.gz                the same, gzipped, cached, with a length,
//                                and an ETag and Last-Modified (304s)
//   /logo/<channels>/<number>.svg  channel logos
//   Xtream (xtream.mjs)          username and password test/test, or
//                                small/small for 50 channels
//   Stalker (stalker.mjs)        portal http://<host>:<port>/c/, MAC
//                                00:1A:79:00:00:01, or 00:1A:79:00:00:02
//                                for 50 channels
// Films and series (vod.mjs) are in the Xtream API and get.php, and in the
// playlist with ?vod=1 (with &films= and &series= for other counts, such as
// a big provider's). They all play one made-up film, encoded at the first
// run, its clock on screen:
//   /vod/film.mp4, .mkv, .ts     with range requests
//   /vod/film.m3u8               HLS, as a VOD playlist
//   /vod/film.srt, .vtt          its subtitles as a separate file, one a
//                                second, saying the time on its clock
//   /poster/<channels>/(film|series)/<id>.svg
//   /backdrop/<channels>/(film|series)/<id>.svg   a wide picture, in
//                                Xtream's film and series details
// Catch-up (PLAN.md, Phase 6, step 2): the playlist's catch-up channels take
// turns at the styles (playlist.mjs), and Xtream has its own. Each makes a
// recording as it is asked for, showing the time it stands for:
//   /archive/<channel>/<Y>-<m>-<d>/<HHMMSS>/<minutes>.ts   default (UTC)
//   /ts/<id>.ts?utc=<s>, /hls/<id>/index.m3u8?utc=<s>      append and shift
//   /fs/<id>/index.m3u8, /fs/<id>/mpegts                   Flussonic live,
//   /fs/<id>/index-<s>-<seconds>.m3u8,                     and its archive
//   /fs/<id>/timeshift_abs-<s>.ts
//   /timeshift/...                                         Xtream (xtream.mjs)
// A made-up Stremio add-on over the same films and series (stremio.mjs):
//   /stremio/manifest.json
// a made-up debrid add-on (debrid.mjs), its streams redirects to files in
// the formats debrid files come in:
//   /debrid/key=velio-test/manifest.json
// and a made-up Cinemeta, Wikidata and TMDB, for the modern Movies and Series:
//   /cinemeta/manifest.json
//   /wikidata/sparql
//   /tmdb/3
// /catchup/log lists the last recordings asked for, to check their times.
// /echo answers with the request's method and headers, to see which headers
// a TV really sends.
// A made-up account on a fake Nuvio server (syncServer.mjs, nuvio.ts)
// answers Nuvio's API as velio.tv does, with the owner's side under /sync/
// and the phone's /link page.
// /backup/<name>.json keeps an app backup (PLAN.md, Phase 5, step 7): PUT
// stores it, in memory until the server stops, and GET answers with it.
// /backup/sample.json is a made-up one, with a 50-channel playlist from
// this server. The index at / lists every URL as JSON.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { catalog, guideWindow, logoSvg } from "./catalog.mjs";
import { m3u, xmltv } from "./playlist.mjs";
import { handleStalker } from "./stalker.mjs";
import {
  germanSubtitle,
  REQUIRED_REFERER,
  REQUIRED_USER_AGENT,
  STREAMS,
  sources,
  subtitles,
} from "./streams.mjs";
import { handleSync } from "./syncServer.mjs";
import { encodeDebridFiles, handleDebrid } from "./debrid.mjs";
import { handleCinemeta, handleStremio, handleTmdb, handleWikidata, titleLabel } from "./stremio.mjs";
import { handleXtream } from "./xtream.mjs";
import { backdropSvg, FILM_SECONDS, filmSubtitles, posterSvg, vodLibrary, vodLines } from "./vod.mjs";

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const PORT = option("port", 8090);
const CHANNELS = option("channels", 10_000);
const DAYS = option("days", 7);
const SMALL = 50;
const MAX_CHANNELS = 50_000;
const MAX_DAYS = 14;
const CLIP_SECONDS = 20;
const cacheDir = path.join(
  process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
  "velio",
  "test-streams",
);
const guideDir = path.join(path.dirname(cacheDir), "test-guides");
const filmDir = path.join(path.dirname(cacheDir), "test-film");
const debridDir = path.join(path.dirname(cacheDir), "test-debrid");
const hlsRoot = mkdtempSync(path.join(tmpdir(), "velio-hls-"));
const children = new Set();
let stopping = false;

const ffmpeg = (args, options = {}) => {
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], options);
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
};

const finished = child =>
  new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });

// Clip names include a hash of their settings, so changing a stream's
// definition re-encodes it.
const clipPath = stream => {
  const hash = createHash("sha1")
    .update(JSON.stringify([stream, sources(stream)]))
    .digest("hex");
  // Subtitles need a container that holds text.
  return path.join(cacheDir, `${stream.id}-${hash.slice(0, 8)}.${stream.tracks ? "mkv" : "ts"}`);
};

const encodeClip = async stream => {
  const target = clipPath(stream);
  if (existsSync(target)) return;
  console.log(`Encoding ${stream.label}...`);
  const { video, audio, audio2 } = sources(stream);
  const partial = `${target}.partial`;
  const inputs = [
    ["-f", "lavfi", "-i", video],
    ["-f", "lavfi", "-i", audio],
  ];
  const maps = ["-map", "0:v", "-map", "1:a"];
  if (stream.tracks) {
    const srt = `${target}.srt`;
    writeFileSync(srt, subtitles(CLIP_SECONDS));
    inputs.push(["-f", "lavfi", "-i", audio2], ["-i", srt]);
    maps.push("-map", "2:a", "-map", "3:s", "-c:s", "srt");
    for (const [kind, language] of [
      ["a:0", "eng"],
      ["a:1", "deu"],
      ["s:0", "eng"],
    ]) {
      maps.push(`-metadata:s:${kind}`, `language=${language}`);
    }
  }
  const args = [
    "-y",
    ...inputs,
    ["-t", String(CLIP_SECONDS)],
    maps,
    stream.video,
    stream.audio,
    ["-f", stream.tracks ? "matroska" : "mpegts", partial],
  ].flat();
  await finished(ffmpeg(args, { stdio: ["ignore", "inherit", "inherit"] }));
  rmSync(`${target}.srt`, { force: true });
  renameSync(partial, target);
};

// Loops the clip at real-time speed, copying it without re-encoding.
const liveArgs = stream => ["-re", "-stream_loop", "-1", "-i", clipPath(stream), "-c", "copy"];

// For the tracks stream, ffmpeg writes the video with both audio tracks
// (media_0.m3u8) and the English subtitles (media_0_vtt.m3u8), and this
// master playlist adds the German ones, served from the English files.
const TRACKS_MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="media_0_vtt.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch",LANGUAGE="de",DEFAULT=NO,AUTOSELECT=YES,URI="de.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",SUBTITLES="subs"
media_0.m3u8
`;

// The made-up film: 720p H.264 and AAC, its clock on screen, as MP4, then
// copied into MKV, raw TS and HLS segments.
const FILM_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const filmText = `drawtext=fontfile=${FILM_FONT}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12`;
const FILM_VERSION = "1";
const filmPath = ext => path.join(filmDir, `film-${FILM_VERSION}.${ext}`);
const encodeFilm = async () => {
  if (existsSync(filmPath("m3u8"))) return;
  console.log(`Encoding the test film (${FILM_SECONDS} s)...`);
  mkdirSync(filmDir, { recursive: true });
  const partial = `${filmPath("mp4")}.partial.mp4`;
  const video = [
    "testsrc2=size=1280x720:rate=25",
    `${filmText}:fontsize=56:x=60:y=60:text='Velio test film'`,
    `${filmText}:fontsize=96:x=60:y=160:text='%{pts\\:hms}'`,
  ].join(",");
  const audio =
    "aevalsrc=0.3*sin(2*PI*440*t)*lt(mod(t\\,1)\\,0.1)|0.3*sin(2*PI*660*t)*lt(mod(t\\,1)\\,0.1):s=48000:c=stereo";
  const encode = ["-y", "-f", "lavfi", "-i", video, "-f", "lavfi", "-i", audio, "-t", String(FILM_SECONDS)];
  const codecs = [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-b:v",
    "1500k",
    ...KEYFRAMES_FILM,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
  ];
  await finished(
    ffmpeg([...encode, ...codecs, "-movflags", "+faststart", partial], {
      stdio: ["ignore", "inherit", "inherit"],
    }),
  );
  renameSync(partial, filmPath("mp4"));
  for (const [ext, format] of [
    ["mkv", "matroska"],
    ["ts", "mpegts"],
  ]) {
    await finished(ffmpeg(["-y", "-i", filmPath("mp4"), "-c", "copy", "-f", format, filmPath(ext)]));
  }
  const segments = path.join(filmDir, `film-${FILM_VERSION}`);
  mkdirSync(segments, { recursive: true });
  await finished(
    ffmpeg(
      [
        [
          "-y",
          "-i",
          filmPath("mp4"),
          "-c",
          "copy",
          "-f",
          "hls",
          "-hls_time",
          "6",
          "-hls_playlist_type",
          "vod",
        ],
        ["-hls_segment_filename", path.join(segments, "seg%03d.ts"), "-hls_base_url", "film/"],
        [filmPath("m3u8")],
      ].flat(),
    ),
  );
};
const KEYFRAMES_FILM = ["-g", "50", "-keyint_min", "50", "-sc_threshold", "0"];

const FILM_TYPES = { mp4: "video/mp4", mkv: "video/x-matroska", ts: "video/mp2t" };

// A file, whole or the range asked for.
const sendFile = (req, res, file, type) => {
  const size = statSync(file).size;
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" };
  if (!range || (range[1] === "" && range[2] === "")) {
    res.writeHead(200, { ...headers, "Content-Length": size });
    void pipeline(createReadStream(file), res).catch(() => {});
    return;
  }
  const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  const end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    ...headers,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${size}`,
  });
  void pipeline(createReadStream(file, { start, end }), res).catch(() => {});
};

const serveFilm = (req, res, url) => {
  const whole = url.pathname.match(/^\/vod\/film\.(mp4|mkv|ts|m3u8)$/);
  if (whole) {
    if (whole[1] === "m3u8")
      return (sendFile(req, res, filmPath("m3u8"), "application/vnd.apple.mpegurl"), true);
    return (sendFile(req, res, filmPath(whole[1]), FILM_TYPES[whole[1]]), true);
  }
  const subtitleFile = url.pathname.match(/^\/vod\/film\.(srt|vtt)$/);
  if (subtitleFile) {
    const type = subtitleFile[1] === "vtt" ? "text/vtt" : "application/x-subrip";
    return (send(res, 200, filmSubtitles(subtitleFile[1]), `${type}; charset=utf-8`), true);
  }
  const segment = url.pathname.match(/^\/vod\/film\/(seg\d+\.ts)$/);
  if (segment) {
    const file = path.join(filmDir, `film-${FILM_VERSION}`, segment[1]);
    if (!existsSync(file)) return (send(res, 404, "Not found\n"), true);
    return (sendFile(req, res, file, "video/mp2t"), true);
  }
  const poster = url.pathname.match(/^\/(poster|backdrop)\/(\d+)\/(film|series)\/(\d+)\.svg$/);
  if (poster && Number(poster[2]) <= MAX_CHANNELS) {
    const draw = poster[1] === "poster" ? posterSvg : backdropSvg;
    const svg = draw(vodLibrary(Number(poster[2])), poster[3], Number(poster[4]));
    if (!svg) return (send(res, 404, `No such ${poster[1]}\n`), true);
    return (send(res, 200, svg, "image/svg+xml"), true);
  }
  return false;
};

// Catch-up recordings, made as they're asked for: a test picture with what
// they are and the time they stand for, which moves on as they play.
const ARCHIVE_SEGMENT_SECONDS = 6;
/** The longest recording made when the request gives no length. */
const ARCHIVE_MAX_SECONDS = 4 * 3600;
const catchupLog = [];
const plainText = text => String(text).replace(/[^\w .|()-]/g, "");
const archiveArgs = ({ label, startMs, offsetSeconds = 0, seconds }) => {
  const at = Math.floor(startMs / 1000) + offsetSeconds;
  const video = [
    "testsrc2=size=1280x720:rate=25",
    `${filmText}:fontsize=44:x=60:y=60:text='Catch-up  ${plainText(label)}'`,
    // The date and time it stands for, in the server's time zone.
    `${filmText}:fontsize=72:x=60:y=150:text='%{pts\\:localtime\\:${at}}'`,
  ].join(",");
  const audio =
    "aevalsrc=0.3*sin(2*PI*550*t)*lt(mod(t\\,1)\\,0.1)|0.3*sin(2*PI*550*t)*lt(mod(t\\,1)\\,0.1):s=48000:c=stereo";
  return [
    ["-f", "lavfi", "-i", video, "-f", "lavfi", "-i", audio, "-t", String(seconds)],
    ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", "2M", ...KEYFRAMES_FILM],
    ["-c:a", "aac", "-b:a", "96k"],
    offsetSeconds ? ["-output_ts_offset", String(offsetSeconds)] : [],
    ["-f", "mpegts", "pipe:1"],
  ].flat();
};
const pipeArchive = (req, res, args) => {
  res.writeHead(200, { "Content-Type": "video/mp2t", "Access-Control-Allow-Origin": "*" });
  const child = ffmpeg(args, { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.pipe(res);
  req.on("close", () => child.kill("SIGKILL"));
};

/**
 * Answers a catch-up request: `start` and `durationMs` say what's asked for,
 * `hls` whether as an HLS playlist. Recordings can't start later than now.
 */
const archive = (req, res, { style, channel, label, start, durationMs, hls = false }) => {
  const name = label ?? `${channel.number}  ${channel.name}`;
  const entry = {
    at: Date.now(),
    style,
    channel: channel?.id,
    label: name,
    start,
    durationMs,
    hls,
    path: req.url,
  };
  catchupLog.unshift(entry);
  catchupLog.length = Math.min(catchupLog.length, 50);
  console.log(
    `Catch-up ${style}: ${name} from ${new Date(start).toISOString()} for ${Math.round((durationMs ?? 0) / 1000)} s`,
  );
  if (!Number.isFinite(start) || start > Date.now()) return send(res, 400, "Not recorded yet\n");
  const seconds = Math.max(
    1,
    Math.min(ARCHIVE_MAX_SECONDS, Math.round((durationMs ?? ARCHIVE_MAX_SECONDS * 1000) / 1000)),
  );
  if (!hls)
    return pipeArchive(req, res, archiveArgs({ label: `${style}  ${name}`, startMs: start, seconds }));
  const count = Math.ceil(seconds / ARCHIVE_SEGMENT_SECONDS);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${ARCHIVE_SEGMENT_SECONDS}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  const tag = encodeURIComponent(plainText(`${style}  ${name}`));
  for (let n = 0; n < count; n++) {
    const length = Math.min(ARCHIVE_SEGMENT_SECONDS, seconds - n * ARCHIVE_SEGMENT_SECONDS);
    lines.push(`#EXTINF:${length}.0,`, `/archive-seg/${start}/${n}/${length}.ts?label=${tag}`);
  }
  lines.push("#EXT-X-ENDLIST");
  send(res, 200, `${lines.join("\n")}\n`, "application/vnd.apple.mpegurl");
};

const serveArchiveSegment = (req, res, url) => {
  const segment = url.pathname.match(/^\/archive-seg\/(\d+)\/(\d+)\/(\d+)\.ts$/);
  if (!segment) return false;
  const [, start, n, length] = segment.map(Number);
  pipeArchive(
    req,
    res,
    archiveArgs({
      label: url.searchParams.get("label") ?? "",
      startMs: start,
      offsetSeconds: n * ARCHIVE_SEGMENT_SECONDS,
      seconds: Math.min(length, ARCHIVE_SEGMENT_SECONDS),
    }),
  );
  return true;
};

// The playlist's catch-up URLs (playlist.mjs), and Flussonic's live ones.
const serveCatchup = (req, res, url) => {
  if (url.pathname === "/catchup/log") {
    send(res, 200, JSON.stringify(catchupLog, null, 2), "application/json");
    return true;
  }
  if (serveArchiveSegment(req, res, url)) return true;
  const plain = url.pathname.match(
    /^\/archive\/(\d+)\/(\d{4})-(\d\d)-(\d\d)\/(\d\d)(\d\d)(\d\d)\/(\d+)\.ts$/,
  );
  if (plain) {
    const [, id, year, month, day, hour, minute, second, minutes] = plain.map(Number);
    const start = Date.UTC(year, month - 1, day, hour, minute, second);
    archive(req, res, { style: "default", label: `channel ${id}`, start, durationMs: minutes * 60_000 });
    return true;
  }
  const utc = url.searchParams.get("utc");
  const stream = url.pathname.match(
    /^\/(?:need-referer\/|need-user-agent\/)?(ts|hls)\/([\w-]+)(?:\.ts|\/index\.m3u8)$/,
  );
  if (utc && stream) {
    // Append and shift ask from a time, and play on until stopped.
    archive(req, res, {
      style: "utc",
      label: stream[2],
      start: Number(utc) * 1000,
      hls: stream[1] === "hls",
    });
    return true;
  }
  const fs = url.pathname.match(
    /^\/fs\/([\w-]+)\/(index\.m3u8|mpegts|index-(\d+)-(\d+)\.m3u8|timeshift_abs-(\d+)\.ts)$/,
  );
  if (!fs || !STREAMS.some(one => one.id === fs[1])) return false;
  const [, id, file, from, seconds, absolute] = fs;
  if (file === "mpegts") return (serveStream(req, res, `/ts/${id}.ts`), true);
  if (file === "index.m3u8") {
    // The live playlist, with segment paths that reach the test stream's.
    const live = path.join(hlsRoot, id, "index.m3u8");
    if (!existsSync(live)) return (send(res, 404, "Not found\n"), true);
    const text = readFileSync(live, "utf8").replace(/^(seg\d+\.ts)$/gm, `/hls/${id}/$1`);
    send(res, 200, text, "application/vnd.apple.mpegurl");
    return true;
  }
  if (from) {
    archive(req, res, {
      style: "flussonic",
      label: id,
      start: Number(from) * 1000,
      durationMs: Number(seconds) * 1000,
      hls: true,
    });
  } else {
    archive(req, res, { style: "flussonic", label: id, start: Number(absolute) * 1000 });
  }
  return true;
};

const hlsOutput = (stream, dir) => {
  const segments = [
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "6",
    "-hls_flags",
    "delete_segments+omit_endlist",
  ];
  if (!stream.tracks) {
    return [segments, "-hls_segment_filename", path.join(dir, "seg%05d.ts"), path.join(dir, "index.m3u8")];
  }
  writeFileSync(path.join(dir, "index.m3u8"), TRACKS_MASTER);
  return [
    ["-map", "0:v", "-map", "0:a", "-map", "0:s", "-c:s", "webvtt"],
    segments,
    ["-var_stream_map", "v:0,a:0,a:1,s:0,sgroup:subs", "-master_pl_name", "ffmpeg.m3u8"],
    ["-hls_segment_filename", path.join(dir, "seg_%v_%05d.ts"), path.join(dir, "media_%v.m3u8")],
  ];
};

const startHls = stream => {
  const dir = path.join(hlsRoot, stream.id);
  mkdirSync(dir, { recursive: true });
  const args = [liveArgs(stream), hlsOutput(stream, dir)].flat(2);
  const child = ffmpeg(args, { stdio: ["ignore", "ignore", "inherit"] });
  child.on("exit", () => {
    if (stopping) return;
    console.error(`HLS for ${stream.id} stopped; restarting.`);
    setTimeout(() => startHls(stream), 1000);
  });
};

const index = host => {
  const base = `http://${host}`;
  const query = `?channels=${CHANNELS}&days=${DAYS}`;
  const urls = stream => ({ ts: `${base}/ts/${stream.id}.ts`, hls: `${base}/hls/${stream.id}/index.m3u8` });
  return {
    streams: STREAMS.map(stream => ({ id: stream.id, label: stream.label, ...urls(stream) })),
    headerTests: [
      { header: "Referer", value: REQUIRED_REFERER, prefix: `${base}/need-referer` },
      { header: "User-Agent", value: REQUIRED_USER_AGENT, prefix: `${base}/need-user-agent` },
    ].map(test => ({
      ...test,
      ts: `${test.prefix}/ts/h264-aac.ts`,
      hls: `${test.prefix}/hls/h264-aac/index.m3u8`,
    })),
    failures: {
      cut: `${base}/fail/cut/15/ts/h264-aac.ts`,
      stall: `${base}/fail/stall/15/ts/h264-aac.ts`,
      notFound: `${base}/fail/status/404/ts/h264-aac.ts`,
      serverError: `${base}/fail/status/500/ts/h264-aac.ts`,
      outage: {
        ts: `${base}/fail/outage/ts/h264-aac.ts`,
        hls: `${base}/fail/outage/hls/h264-aac/index.m3u8`,
      },
      startOutage: `${base}/fail/outage?seconds=10`,
    },
    sources: {
      playlist: `${base}/playlist.m3u${query}`,
      playlistWithVod: `${base}/playlist.m3u${query}&vod=1`,
      guide: `${base}/guide.xml${query}`,
      guideGzip: `${base}/guide.xml.gz${query}`,
      xtream: { server: base, accounts: ["test/test", `small/small (${SMALL} channels)`] },
      stalker: { portal: `${base}/c/`, macs: ["00:1A:79:00:00:01", `00:1A:79:00:00:02 (${SMALL} channels)`] },
    },
    backup: { sample: `${base}/backup/sample.json`, yours: `${base}/backup/<name>.json` },
    sync: {
      site: base,
      pair: `${base}/pair`,
      account: `${base}/sync/`,
      approve: `${base}/sync/approve?code=<code>&profiles=Kids,Guest`,
    },
    film: ["mp4", "mkv", "ts", "m3u8"].map(ext => `${base}/vod/film.${ext}`),
    filmSubtitles: ["srt", "vtt"].map(ext => `${base}/vod/film.${ext}`),
    stremioAddon: `${base}/stremio/manifest.json`,
    debridAddon: `${base}/debrid/key=velio-test/manifest.json`,
    debridLog: `${base}/debrid/log`,
    cinemeta: `${base}/cinemeta/manifest.json`,
    wikidata: `${base}/wikidata/sparql`,
    tmdb: `${base}/tmdb/3`,
    catchupLog: `${base}/catchup/log`,
  };
};

// Backups the app sent, by name.
const backups = new Map();
const MAX_BACKUP_BYTES = 1_000_000;

// The app's id for a sample channel: its source, then its name (src/data/channelKey.ts).
const sampleId = channel => `sample/n:${channel.name.toLowerCase()}`;

// A made-up backup: one playlist from this server, some edits and settings.
const sampleBackup = base => ({
  app: "velio",
  version: 1,
  savedAt: Date.now(),
  sources: [
    {
      id: "sample",
      name: "Sample playlist",
      kind: "m3u",
      url: `${base}/playlist.m3u?channels=${SMALL}`,
      refreshHours: 24,
    },
  ],
  edits: (() => {
    const [first, second] = catalog(SMALL).channels;
    return { favourites: [sampleId(second), sampleId(first)], groupNames: { [first.group]: "Renamed news" } };
  })(),
  settings: { startOn: "guide", clock: "24h" },
});

const serveBackup = (req, res, url, base) => {
  const name = url.pathname.match(/^\/backup\/([\w-]+)\.json$/)?.[1];
  if (!name) return false;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }
  if (req.method === "PUT") {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size <= MAX_BACKUP_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BACKUP_BYTES) return send(res, 413, "Too large\n");
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        JSON.parse(text);
      } catch {
        return send(res, 400, "Not JSON\n");
      }
      backups.set(name, text);
      send(res, 204, "");
    });
    return true;
  }
  const body = name === "sample" ? JSON.stringify(sampleBackup(base), null, 2) : backups.get(name);
  if (body === undefined) send(res, 404, "No such backup\n");
  else send(res, 200, body, "application/json");
  return true;
};

const send = (res, status, body, type = "text/plain") => {
  res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(body);
};

// Sends generated text chunks as they are made, stopping if the client goes.
const sendChunks = (res, chunks, type) => {
  res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  pipeline(Readable.from(chunks), res).catch(() => {});
  return true;
};

const sourceSettings = url => {
  const number = (name, fallback, max) => {
    const value = Number(url.searchParams.get(name) ?? fallback);
    return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
  };
  return { count: number("channels", CHANNELS, MAX_CHANNELS), days: number("days", DAYS, MAX_DAYS) };
};

// Gzipped guides are cached, keyed by their settings, start day and the code
// that writes them, and made only once when several requests ask at once.
const guideCode = createHash("sha1")
  .update(["catalog.mjs", "playlist.mjs"].map(file => readFileSync(new URL(file, import.meta.url))).join(""))
  .digest("hex")
  .slice(0, 8);
const gzipJobs = new Map();
const gzippedGuide = (base, { count, days }) => {
  const window = guideWindow(days);
  const day = new Date(window.start).toISOString().slice(0, 10);
  const host = createHash("sha1").update(base).digest("hex").slice(0, 6);
  const name = `guide-${day}-${count}-${days}-${host}-${guideCode}.xml.gz`;
  const file = path.join(guideDir, name);
  if (existsSync(file)) return Promise.resolve(file);
  if (!gzipJobs.has(name)) {
    const job = (async () => {
      mkdirSync(guideDir, { recursive: true });
      for (const old of readdirSync(guideDir)) {
        if (!old.startsWith(`guide-${day}-`)) rmSync(path.join(guideDir, old), { force: true });
      }
      console.log(`Writing ${name}...`);
      const partial = `${file}.partial`;
      const chunks = xmltv({ base, channels: catalog(count).channels, window });
      await pipeline(Readable.from(chunks), createGzip(), createWriteStream(partial));
      renameSync(partial, file);
      return file;
    })().finally(() => gzipJobs.delete(name));
    gzipJobs.set(name, job);
  }
  return gzipJobs.get(name);
};

// With an ETag and Last-Modified, answering 304 when they match, as static
// file servers do.
const sendGzippedGuide = async (req, res, base, settings) => {
  let file;
  try {
    file = await gzippedGuide(base, settings);
  } catch (error) {
    send(res, 500, `${error.message}\n`);
    return;
  }
  const { size, mtime } = statSync(file);
  const etag = `"${path.basename(file, ".xml.gz")}"`;
  const lastModified = mtime.toUTCString();
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "ETag, Last-Modified",
  };
  const since = Date.parse(req.headers["if-modified-since"] ?? "");
  const match = req.headers["if-none-match"];
  if (match === etag || (match === undefined && since >= Math.floor(mtime.getTime() / 1000) * 1000)) {
    res.writeHead(304, { ETag: etag, "Last-Modified": lastModified, ...cors });
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Length": size,
    ETag: etag,
    "Last-Modified": lastModified,
    ...cors,
  });
  await pipeline(createReadStream(file), res).catch(() => {});
};

// The outage that /fail/outage?seconds= starts, and the streams it cuts off.
let outageUntil = 0;
let outageHangs = false;
/** Each stream's response, and how to make it stop sending. */
const outageResponses = new Map();

const serveSource = (req, res, url, base) => {
  const settings = sourceSettings(url);
  const query = `?channels=${settings.count}&days=${settings.days}`;
  if (url.pathname === "/playlist.m3u") {
    // With ?vod=1, films and episodes as video files, which only their
    // extension tells from channels; raw TS ones would pass for channels.
    // ?films= and ?series= give their counts, as a big provider's might.
    const count = name => {
      const value = Number(url.searchParams.get(name));
      return Number.isInteger(value) && value > 0 ? Math.min(value, 200_000) : undefined;
    };
    const sizes = { films: count("films"), series: count("series") };
    const extra =
      url.searchParams.get("vod") === "1"
        ? vodLines(vodLibrary(settings.count, sizes), base, (kind, id, ext) => {
            const file = ext === "mkv" ? "mkv" : "mp4";
            return `${base}/vod/film.${file}?${kind}=${id}`;
          })
        : [];
    const body = m3u({
      base,
      channels: catalog(settings.count).channels,
      guideUrl: `${base}/guide.xml.gz${query}`,
      extra,
    });
    send(res, 200, body, "audio/x-mpegurl");
    return true;
  }
  if (url.pathname === "/guide.xml") {
    const channels = catalog(settings.count).channels;
    return sendChunks(res, xmltv({ base, channels, window: guideWindow(settings.days) }), "application/xml");
  }
  if (url.pathname === "/guide.xml.gz") {
    if (req.method === "OPTIONS") {
      // A browser asks first before sending If-None-Match.
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "If-None-Match, If-Modified-Since",
      });
      res.end();
      return true;
    }
    void sendGzippedGuide(req, res, base, settings);
    return true;
  }
  const logo = url.pathname.match(/^\/logo\/(\d+)\/(\d+)\.svg$/);
  if (logo && Number(logo[1]) <= MAX_CHANNELS) {
    const channel = catalog(Number(logo[1])).channels[Number(logo[2]) - 1];
    if (!channel) return false;
    send(res, 200, logoSvg(channel), "image/svg+xml");
    return true;
  }
  return false;
};

const accounts = new Map([
  [
    "test:test",
    { username: "test", password: "test", catalog: catalog(CHANNELS), vod: vodLibrary(CHANNELS) },
  ],
  ["small:small", { username: "small", password: "small", catalog: catalog(SMALL), vod: vodLibrary(SMALL) }],
]);
const macs = new Map([
  ["00:1A:79:00:00:01", { id: 1, name: "Test", mac: "00:1A:79:00:00:01", catalog: catalog(CHANNELS) }],
  ["00:1A:79:00:00:02", { id: 2, name: "Small", mac: "00:1A:79:00:00:02", catalog: catalog(SMALL) }],
]);

// `fault` makes a raw TS stream fail on purpose: { cutMs } drops the
// connection after that long, { stallMs } stops sending but keeps it open.
const serveStream = (req, res, route, fault = {}) => {
  const ts = route.match(/^\/ts\/([\w-]+)\.ts$/);
  if (ts) {
    const stream = STREAMS.find(s => s.id === ts[1]);
    if (!stream) return send(res, 404, "Unknown stream\n");
    res.writeHead(200, { "Content-Type": "video/mp2t", "Access-Control-Allow-Origin": "*" });
    // Raw TS can't hold the WebVTT subtitles.
    const child = ffmpeg([...liveArgs(stream), "-map", "0:v", "-map", "0:a", "-f", "mpegts", "pipe:1"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.pipe(res);
    const stall = () => {
      child.stdout.unpipe(res);
      child.kill("SIGKILL");
    };
    fault.started?.(stall);
    const timers = [];
    if (fault.cutMs !== undefined) {
      timers.push(setTimeout(() => res.destroy(), fault.cutMs));
    }
    if (fault.stallMs !== undefined) timers.push(setTimeout(stall, fault.stallMs));
    req.on("close", () => {
      for (const timer of timers) clearTimeout(timer);
      child.kill("SIGKILL");
    });
    return;
  }

  const hls = route.match(/^\/hls\/([\w-]+)\/([\w-]+\.(m3u8|ts|vtt))$/);
  if (hls && STREAMS.some(s => s.id === hls[1])) {
    // The German subtitles are the English ones, renamed and translated.
    const german =
      hls[2] === "de.m3u8" ? "media_0_vtt.m3u8" : hls[2].replace(/^de_(\d+)\.vtt$/, "media_0$1.vtt");
    const file = path.join(hlsRoot, hls[1], german);
    if (!existsSync(file)) return send(res, 404, "Not found\n");
    const types = { m3u8: "application/vnd.apple.mpegurl", ts: "video/mp2t", vtt: "text/vtt" };
    res.writeHead(200, {
      "Content-Type": types[hls[3]],
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    if (german === hls[2]) return void createReadStream(file).pipe(res);
    const text = readFileSync(file, "utf8");
    res.end(hls[3] === "m3u8" ? text.replace(/^media_0(\d+)\.vtt$/gm, "de_$1.vtt") : germanSubtitle(text));
    return;
  }

  send(res, 404, "Not found\n");
};

const handle = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  console.log(`${req.method} ${url.pathname} (${req.headers["user-agent"] ?? "no user agent"})`);
  if (url.pathname === "/") {
    return send(res, 200, JSON.stringify(index(req.headers.host), null, 2), "application/json");
  }
  if (url.pathname === "/echo") {
    return send(res, 200, JSON.stringify({ method: req.method, headers: req.headers }), "application/json");
  }
  const base = `http://${req.headers.host ?? "localhost"}`;
  if (handleSync(req, res, url, base)) return;
  if (handleStremio(res, url, base, send)) return;
  if (handleDebrid(req, res, url, base, { send, sendFile, dir: debridDir, titleName: titleLabel })) return;
  if (handleCinemeta(res, url, base, send)) return;
  if (handleWikidata(res, url, send)) return;
  if (handleTmdb(res, url, send)) return;
  if (serveBackup(req, res, url, base)) return;
  if (serveSource(req, res, url, base)) return;
  if (serveFilm(req, res, url) || serveCatchup(req, res, url)) return;
  const ctx = { base, send, sendChunks, accounts, macs, archive, now: Date.now(), window: guideWindow(DAYS) };
  if (handleXtream(req, res, url, ctx) || handleStalker(req, res, url, ctx)) return;

  const referer = url.pathname.match(/^\/need-referer(\/.*)$/);
  if (referer) {
    if (req.headers.referer !== REQUIRED_REFERER) return send(res, 403, "Wrong or missing Referer\n");
    return serveStream(req, res, referer[1]);
  }
  const agent = url.pathname.match(/^\/need-user-agent(\/.*)$/);
  if (agent) {
    if (!req.headers["user-agent"]?.includes(REQUIRED_USER_AGENT)) {
      return send(res, 403, "Wrong or missing User-Agent\n");
    }
    return serveStream(req, res, agent[1]);
  }
  const fail = url.pathname.match(/^\/fail\/(cut|stall|status)\/(\d+)(\/.*)$/);
  if (fail) {
    const [, kind, amount, route] = fail;
    if (kind === "status") return send(res, Number(amount), `Failing with ${amount} on purpose\n`);
    return serveStream(
      req,
      res,
      route,
      kind === "cut" ? { cutMs: amount * 1000 } : { stallMs: amount * 1000 },
    );
  }
  if (url.pathname === "/fail/outage") {
    const seconds = Math.min(Number(url.searchParams.get("seconds")) || 10, 600);
    outageUntil = Date.now() + seconds * 1000;
    outageHangs = url.searchParams.get("hang") === "1";
    for (const [response, stall] of outageResponses) {
      if (outageHangs) stall();
      else response.destroy();
    }
    console.log(`Outage for ${seconds} s${outageHangs ? ", hanging" : ""}.`);
    return send(res, 200, JSON.stringify({ seconds, hang: outageHangs }), "application/json");
  }
  const outage = url.pathname.match(/^\/fail\/outage(\/.*)$/);
  if (outage) {
    if (Date.now() < outageUntil) {
      // No answer at all; the client gives up when it wants to.
      if (outageHangs) return;
      return send(res, 503, "Outage on purpose\n");
    }
    // HLS files are sent whole; only raw TS streams can stall.
    outageResponses.set(res, () => res.destroy());
    res.on("close", () => outageResponses.delete(res));
    return serveStream(req, res, outage[1], { started: stall => outageResponses.set(res, stall) });
  }
  return serveStream(req, res, url.pathname);
};

const stop = () => {
  stopping = true;
  for (const child of children) child.kill("SIGKILL");
  rmSync(hlsRoot, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

mkdirSync(cacheDir, { recursive: true });
// Clips left over from older stream definitions.
const current = new Set(STREAMS.map(stream => path.basename(clipPath(stream))));
for (const file of readdirSync(cacheDir)) {
  if (!current.has(file)) rmSync(path.join(cacheDir, file), { force: true });
}
for (const stream of STREAMS) await encodeClip(stream);
await encodeFilm();
await encodeDebridFiles({ ffmpeg, finished, source: filmPath("mp4"), dir: debridDir });
for (const stream of STREAMS) startHls(stream);

const server = http.createServer(handle);
server.listen(PORT, () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter(address => address?.family === "IPv4" && !address.internal)
    .map(address => `http://${address.address}:${PORT}/`);
  console.log(`Serving ${STREAMS.length} test streams. Index:\n  ${addresses.join("\n  ")}`);
});
