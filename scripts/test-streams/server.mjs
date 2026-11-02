#!/usr/bin/env node
// Serves live test streams, for checking which formats a TV plays.
// Run it inside the tv-dev box, which has ffmpeg:
//
//   node scripts/test-streams/server.mjs [--port 8090]
//
// The first run encodes a 20-second clip per stream, which takes a few
// minutes; later runs reuse them. Each clip then loops live, as:
//   /ts/<id>.ts                  raw MPEG-TS over HTTP
//   /hls/<id>/index.m3u8         HLS
// Under /need-referer/ and /need-user-agent/, the same paths only answer
// requests with the right header, to test streams that need custom headers.
// The index at / lists every URL as JSON.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { STREAMS, sources } from "./streams.mjs";

const REQUIRED_REFERER = "http://tiviplayer.test/";
const REQUIRED_USER_AGENT = "TiviPlayerTest";

const portArg = process.argv.indexOf("--port");
const PORT = portArg === -1 ? 8090 : Number(process.argv[portArg + 1]);
const CLIP_SECONDS = 20;
const cacheDir = path.join(
  process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
  "tiviplayer",
  "test-streams",
);
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
  };
};

const send = (res, status, body, type = "text/plain") => {
  res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(body);
};

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
