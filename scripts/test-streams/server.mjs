#!/usr/bin/env node
// Serves live test streams, for checking which formats a TV plays, and made-up
// IPTV sources that play them. Run it inside the tv-dev box, which has ffmpeg:
//
//   node scripts/test-streams/server.mjs [--port 8090] [--channels 10000] [--days 7]
//
// The first run encodes a 20-second clip per stream, which takes a few
// minutes; later runs reuse them. Each clip then loops live, as:
//   /ts/<id>.ts                  raw MPEG-TS over HTTP
//   /hls/<id>/index.m3u8         HLS
// Under /need-referer/ and /need-user-agent/, the same paths only answer
// requests with the right header, to test streams that need custom headers.
//
// The sources (see catalog.mjs) have --channels channels and --days days of
// guide, starting yesterday; ?channels= and ?days= change them per request:
//   /playlist.m3u                M3U playlist
//   /guide.xml                   XMLTV guide, generated as it is sent
//   /guide.xml.gz                the same, gzipped, cached and with a length
//   /logo/<channels>/<number>.svg  channel logos
//   Xtream (xtream.mjs)          username and password test/test, or
//                                small/small for 50 channels
//   Stalker (stalker.mjs)        portal http://<host>:<port>/c/, MAC
//                                00:1A:79:00:00:01, or 00:1A:79:00:00:02
//                                for 50 channels
// /echo answers with the request's method and headers, to see which headers
// a TV really sends. The index at / lists every URL as JSON.

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
import { REQUIRED_REFERER, REQUIRED_USER_AGENT, STREAMS, sources } from "./streams.mjs";
import { handleXtream } from "./xtream.mjs";

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
  "tiviplayer",
  "test-streams",
);
const guideDir = path.join(path.dirname(cacheDir), "test-guides");
const hlsRoot = mkdtempSync(path.join(tmpdir(), "tiviplayer-hls-"));
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
  return path.join(cacheDir, `${stream.id}-${hash.slice(0, 8)}.ts`);
};

const encodeClip = async stream => {
  const target = clipPath(stream);
  if (existsSync(target)) return;
  console.log(`Encoding ${stream.label}...`);
  const { video, audio } = sources(stream);
  const partial = `${target}.partial`;
  const args = [
    "-y",
    ["-f", "lavfi", "-i", video],
    ["-f", "lavfi", "-i", audio],
    ["-t", String(CLIP_SECONDS), "-map", "0:v", "-map", "1:a"],
    stream.video,
    stream.audio,
    ["-f", "mpegts", partial],
  ].flat();
  await finished(ffmpeg(args, { stdio: ["ignore", "inherit", "inherit"] }));
  renameSync(partial, target);
};

// Loops the clip at real-time speed, copying it without re-encoding.
const liveArgs = stream => ["-re", "-stream_loop", "-1", "-i", clipPath(stream), "-c", "copy"];

const startHls = stream => {
  const dir = path.join(hlsRoot, stream.id);
  mkdirSync(dir, { recursive: true });
  const args = [
    liveArgs(stream),
    ["-f", "hls", "-hls_time", "2", "-hls_list_size", "6"],
    ["-hls_flags", "delete_segments+omit_endlist"],
    ["-hls_segment_filename", path.join(dir, "seg%05d.ts"), path.join(dir, "index.m3u8")],
  ].flat();
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
    sources: {
      playlist: `${base}/playlist.m3u${query}`,
      guide: `${base}/guide.xml${query}`,
      guideGzip: `${base}/guide.xml.gz${query}`,
      xtream: { server: base, accounts: ["test/test", `small/small (${SMALL} channels)`] },
      stalker: { portal: `${base}/c/`, macs: ["00:1A:79:00:00:01", `00:1A:79:00:00:02 (${SMALL} channels)`] },
    },
  };
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

const sendGzippedGuide = async (res, base, settings) => {
  let file;
  try {
    file = await gzippedGuide(base, settings);
  } catch (error) {
    send(res, 500, `${error.message}\n`);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Length": statSync(file).size,
    "Access-Control-Allow-Origin": "*",
  });
  await pipeline(createReadStream(file), res).catch(() => {});
};

const serveSource = (req, res, url, base) => {
  const settings = sourceSettings(url);
  const query = `?channels=${settings.count}&days=${settings.days}`;
  if (url.pathname === "/playlist.m3u") {
    const body = m3u({
      base,
      channels: catalog(settings.count).channels,
      guideUrl: `${base}/guide.xml.gz${query}`,
    });
    send(res, 200, body, "audio/x-mpegurl");
    return true;
  }
  if (url.pathname === "/guide.xml") {
    const channels = catalog(settings.count).channels;
    return sendChunks(res, xmltv({ base, channels, window: guideWindow(settings.days) }), "application/xml");
  }
  if (url.pathname === "/guide.xml.gz") {
    void sendGzippedGuide(res, base, settings);
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
  ["test:test", { username: "test", password: "test", catalog: catalog(CHANNELS) }],
  ["small:small", { username: "small", password: "small", catalog: catalog(SMALL) }],
]);
const macs = new Map([
  ["00:1A:79:00:00:01", { id: 1, name: "Test", mac: "00:1A:79:00:00:01", catalog: catalog(CHANNELS) }],
  ["00:1A:79:00:00:02", { id: 2, name: "Small", mac: "00:1A:79:00:00:02", catalog: catalog(SMALL) }],
]);

const serveStream = (req, res, route) => {
  const ts = route.match(/^\/ts\/([\w-]+)\.ts$/);
  if (ts) {
    const stream = STREAMS.find(s => s.id === ts[1]);
    if (!stream) return send(res, 404, "Unknown stream\n");
    res.writeHead(200, { "Content-Type": "video/mp2t", "Access-Control-Allow-Origin": "*" });
    const child = ffmpeg([...liveArgs(stream), "-f", "mpegts", "pipe:1"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.pipe(res);
    req.on("close", () => child.kill("SIGKILL"));
    return;
  }

  const hls = route.match(/^\/hls\/([\w-]+)\/([\w-]+\.(m3u8|ts))$/);
  if (hls && STREAMS.some(s => s.id === hls[1])) {
    const file = path.join(hlsRoot, hls[1], hls[2]);
    if (!existsSync(file)) return send(res, 404, "Not found\n");
    res.writeHead(200, {
      "Content-Type": hls[3] === "m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    createReadStream(file).pipe(res);
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
  if (serveSource(req, res, url, base)) return;
  const ctx = { base, send, sendChunks, accounts, macs, now: Date.now(), window: guideWindow(DAYS) };
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
for (const stream of STREAMS) startHls(stream);

http.createServer(handle).listen(PORT, () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter(address => address?.family === "IPv4" && !address.internal)
    .map(address => `http://${address.address}:${PORT}/`);
  console.log(`Serving ${STREAMS.length} test streams. Index:\n  ${addresses.join("\n  ")}`);
});
