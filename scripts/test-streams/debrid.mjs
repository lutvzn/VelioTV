// A made-up debrid add-on (PLAN.md, "Debrid add-ons"), as Torrentio, Comet
// or MediaFusion answer once set up with a debrid key: a stream-only
// add-on whose settings are in its manifest's path, and whose streams are
// links to its own "resolve" address, which sends the player on (302s) to
// the debrid service's copy of the file. Add it to the mock Velio account
// with /sync/add-list?kind=stremio&path=/debrid/key=velio-test/manifest.json
//   /debrid/<settings>/manifest.json
//   /debrid/<settings>/stream/(movie|series)/<id>.json
//   /debrid/<settings>/resolve/<file>?wait=<ms>&hops=<n>&fail=<status>
//                       waits, then sends the player through n more
//                       redirects to the file; or fails with that status
//   /debrid/cdn/<n>/<file>  one of those redirects
//   /debrid/files/<file>    the file, with range requests
//   /debrid/log[?clear=1]   the resolves and file requests, with their
//                       Range headers, to see what the player asks again
// Only the key "velio-test" is right; the resolve refuses others (403).
//
// It has streams for the test add-on's films and episodes (stremio.mjs):
// one per file below, each a minute of the test film (its clock on screen)
// in the video and audio debrid files often have, then the H.264 one
// again, resolved slowly, refused, and as a direct link.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { filmSubtitles } from "./vod.mjs";

const KEY = "velio-test";
const SECONDS = 60;
const FILES_VERSION = "1";

/** 5.1 from the film's stereo, so the surround formats have six channels. */
const SURROUND = "pan=5.1|FL=c0|FR=c1|FC=0.5*c0+0.5*c1|LFE=0*c0|BL=c0|BR=c1";

/**
 * Each file: its video (H.264 as the film has it, or HEVC 10-bit), its
 * audio tracks ([encoder, channels, language]), its subtitles, its container.
 */
export const DEBRID_FILES = [
  { id: "h264-aac", label: "H.264, AAC stereo", video: "h264", audio: [["aac", 2]] },
  { id: "hevc10-aac", label: "HEVC 10-bit, AAC stereo", audio: [["aac", 2]] },
  { id: "hevc10-ac3", label: "HEVC 10-bit, AC-3 5.1", audio: [["ac3", 6]] },
  { id: "hevc10-eac3", label: "HEVC 10-bit, E-AC-3 5.1", audio: [["eac3", 6]] },
  { id: "hevc10-dts", label: "HEVC 10-bit, DTS 5.1", audio: [["dca", 6]] },
  { id: "hevc10-truehd", label: "HEVC 10-bit, TrueHD 5.1", audio: [["truehd", 6]] },
  { id: "hevc10-flac", label: "HEVC 10-bit, FLAC stereo", audio: [["flac", 2]] },
  { id: "hevc10-opus", label: "HEVC 10-bit, Opus 5.1", audio: [["libopus", 6]] },
  {
    id: "hevc10-dts-aac-subs",
    label: "HEVC 10-bit, DTS 5.1 then AAC, SRT and ASS subtitles",
    audio: [
      ["dca", 6, "eng"],
      ["aac", 2, "ita"],
    ],
    subtitles: [
      ["srt", "eng"],
      ["ass", "spa"],
    ],
  },
  { id: "hevc10-eac3-mp4", label: "HEVC 10-bit, E-AC-3 5.1, as MP4", audio: [["eac3", 6]], mp4: true },
];

const extOf = file => (file.mp4 ? "mp4" : "mkv");
const fileName = file => `velio-test-film.${file.id}.${extOf(file)}`;
const fileOf = name => DEBRID_FILES.find(file => fileName(file) === name);

/** Encodes the files from the test film (`source`, MP4) into `dir`, once. */
export const encodeDebridFiles = async ({ ffmpeg, finished, source, dir }) => {
  const at = file => path.join(dir, `${FILES_VERSION}-${fileName(file)}`);
  if (DEBRID_FILES.every(file => existsSync(at(file)))) return;
  mkdirSync(dir, { recursive: true });
  console.log("Encoding the debrid test files...");
  const run = args => finished(ffmpeg(["-y", ...args], { stdio: ["ignore", "inherit", "inherit"] }));
  // The HEVC video once, then each file copies it.
  const hevc = path.join(dir, `${FILES_VERSION}-hevc10.mkv`);
  if (!existsSync(hevc)) {
    await run(
      [
        ["-t", String(SECONDS), "-i", source, "-map", "0:v"],
        ["-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le"],
        ["-x265-params", "log-level=error:keyint=50:min-keyint=50", `${hevc}.partial.mkv`],
      ].flat(),
    );
    renameSync(`${hevc}.partial.mkv`, hevc);
  }
  const srt = path.join(dir, "film.srt");
  writeFileSync(srt, filmSubtitles("srt"));
  for (const file of DEBRID_FILES) {
    const target = at(file);
    if (existsSync(target)) continue;
    const inputs = [file.video === "h264" ? ["-t", String(SECONDS), "-i", source] : ["-i", hevc]];
    inputs.push(["-t", String(SECONDS), "-i", source]);
    const maps = ["-map", "0:v", "-c:v", "copy"];
    if (file.mp4) maps.push("-tag:v", "hvc1");
    file.audio.forEach(([encoder, channels, language], i) => {
      maps.push("-map", "1:a", `-c:a:${i}`, encoder);
      if (channels === 6) maps.push(`-filter:a:${i}`, SURROUND);
      if (encoder === "libopus") maps.push(`-mapping_family:a:${i}`, "1");
      if (language) maps.push(`-metadata:s:a:${i}`, `language=${language}`);
    });
    (file.subtitles ?? []).forEach(([codec, language], i) => {
      inputs.push(["-i", srt]);
      maps.push(
        "-map",
        `${inputs.length - 1}:s`,
        `-c:s:${i}`,
        codec,
        `-metadata:s:s:${i}`,
        `language=${language}`,
      );
    });
    const partial = `${target}.partial.${extOf(file)}`;
    await run([...inputs.flat(), ...maps, "-strict", "-2", "-t", String(SECONDS), partial]);
    renameSync(partial, target);
  }
  rmSync(srt, { force: true });
};

const manifest = {
  id: "tv.velio.test.debrid",
  version: "1.0.0",
  name: "Velio debrid test",
  description: "Made-up debrid streams: redirects, slow resolves, and the formats debrid files come in.",
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  resources: ["stream"],
  catalogs: [],
  behaviorHints: { configurable: true },
};

const streamsFor = (base, settings, label) => {
  const resolve = (file, query = "") => `${base}/debrid/${settings}/resolve/${fileName(file)}${query}`;
  const stream = (file, title, url, what) => ({
    name: `[RD+] Velio\n${title}`,
    description: `${label}\n${what}`,
    url,
    behaviorHints: { bingeGroup: `velio-debrid|${file.id}|${what}`, filename: fileName(file) },
  });
  const [h264] = DEBRID_FILES;
  return [
    ...DEBRID_FILES.map(file => stream(file, file.id, resolve(file, "?hops=2"), `${file.label}, cached`)),
    stream(h264, "5 s", resolve(h264, "?wait=5000&hops=2"), "Not cached: 5 s to resolve"),
    stream(h264, "20 s", resolve(h264, "?wait=20000&hops=2"), "Not cached: 20 s to resolve"),
    stream(h264, "503", resolve(h264, "?fail=503"), "The resolve fails (503)"),
    stream(h264, "direct", `${base}/debrid/files/${fileName(h264)}`, "A direct link, no redirect"),
  ];
};

const log = [];
const note = (req, kind, what) => {
  log.push({ at: Date.now(), kind, what, range: req.headers.range ?? null });
  if (log.length > 500) log.shift();
};

/** Answers the debrid add-on's requests; false for other paths. */
export const handleDebrid = (req, res, url, base, { send, sendFile, dir, titleName }) => {
  if (!url.pathname.startsWith("/debrid/")) return false;
  const json = (status, value) => send(res, status, JSON.stringify(value), "application/json");
  const redirect = to => {
    res.writeHead(302, { Location: to, "Access-Control-Allow-Origin": "*" });
    res.end();
  };

  if (url.pathname === "/debrid/log") {
    const answer = [...log];
    if (url.searchParams.get("clear") === "1") log.length = 0;
    return (json(200, answer), true);
  }
  const file = url.pathname.match(/^\/debrid\/files\/([^/]+)$/);
  if (file) {
    const found = fileOf(file[1]);
    if (!found) return (send(res, 404, "Not found\n"), true);
    note(req, "file", found.id);
    const type = found.mp4 ? "video/mp4" : "video/x-matroska";
    return (sendFile(req, res, path.join(dir, `${FILES_VERSION}-${fileName(found)}`), type), true);
  }
  const hop = url.pathname.match(/^\/debrid\/cdn\/(\d+)\/([^/]+)$/);
  if (hop) {
    const left = Number(hop[1]);
    note(req, "redirect", hop[2]);
    return (
      redirect(left > 0 ? `${base}/debrid/cdn/${left - 1}/${hop[2]}` : `${base}/debrid/files/${hop[2]}`), true
    );
  }

  const parts = url.pathname.match(
    /^\/debrid\/([^/]+)\/(manifest\.json|stream\/(movie|series)\/([^/]+)\.json|resolve\/([^/]+))$/,
  );
  if (!parts) return (send(res, 404, "Not found\n"), true);
  const [, settings, , type, rawId, resolveName] = parts;
  const key = new URLSearchParams(decodeURIComponent(settings)).get("key");
  if (parts[2] === "manifest.json") return (json(200, manifest), true);
  if (type) {
    const id = decodeURIComponent(rawId);
    const label = titleName(type, id);
    return (json(200, { streams: label ? streamsFor(base, settings, label) : [] }), true);
  }
  note(req, "resolve", `${resolveName}${url.search}`);
  if (!fileOf(resolveName)) return (send(res, 404, "Not found\n"), true);
  if (key !== KEY) return (send(res, 403, "Wrong debrid key\n"), true);
  const fail = Number(url.searchParams.get("fail"));
  const wait = Math.min(Number(url.searchParams.get("wait")) || 0, 60_000);
  const hops = Math.min(Number(url.searchParams.get("hops")) || 0, 5);
  setTimeout(() => {
    if (fail) send(res, fail, `Failing with ${fail} on purpose\n`);
    else
      redirect(
        hops > 0 ? `${base}/debrid/cdn/${hops - 1}/${resolveName}` : `${base}/debrid/files/${resolveName}`,
      );
  }, wait);
  return true;
};
