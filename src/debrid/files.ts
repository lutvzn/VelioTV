// Which file of a torrent to play, of those a debrid service lists: the one
// the add-on named, else the episode's by its number, else the one at the
// add-on's place, else the biggest video. And the torrent's magnet link.
//
// After NuvioTVSmart's js/core/debrid/debridFileSelection.js and the magnet
// link in js/core/debrid/directDebridResolver.js
// (https://github.com/NuvioMedia/NuvioTVSmart, GPL-3.0); changed: rewritten
// in TypeScript for one file shape.

/** A torrent an add-on listed, to play through a debrid service. */
export interface Torrent {
  /** In lower case. */
  infoHash: string;
  /** The file's place in the torrent, from 0, as Stremio add-ons give it. */
  fileIdx?: number;
  /** Trackers, as "tracker:<url>", and "dht:<hash>". */
  sources: string[];
  /** The episode it's for, to find its file in a season's torrent. */
  season?: number;
  episode?: number;
}

/** A file as a debrid service lists it. */
export interface ServiceFile {
  /** The service's id for it, to ask its link. */
  id: string;
  /** Its name, or its path in the torrent. */
  name: string;
  size: number;
  /** Its link, for services that list one with each file. */
  link?: string;
  mime?: string;
}

const VIDEO = /\.(mp4|mkv|webm|avi|mov|m4v|ts|m2ts|wmv|flv)$/i;

/** The last part of a path. */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? "";

const isVideo = (file: ServiceFile) =>
  (file.mime ?? "").toLowerCase().startsWith("video/") || VIDEO.test(baseName(file.name));

/** Its name without the extension, in lower case, with spaces for the rest. */
const plainName = (name: string) =>
  baseName(name)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
const episodeWords = (season?: number, episode?: number) =>
  season && episode
    ? [`s${pad(season)}e${pad(episode)}`, `${season}x${pad(episode)}`, `${season}x${episode}`]
    : [];

/**
 * The file to play: the add-on's file name, else the episode's number in
 * the name, else the add-on's place (from 0, else from 1, else as the
 * service's id), else the biggest video. None when the torrent has no video.
 */
export const pickFile = (
  files: ServiceFile[],
  torrent: Torrent,
  filename?: string,
): ServiceFile | undefined => {
  const videos = files.filter(isVideo);
  if (videos.length === 0) return undefined;
  const wanted = filename ? plainName(filename) : "";
  if (wanted) {
    const named = videos.find(file => {
      const name = plainName(file.name);
      return name !== "" && (name.includes(wanted) || wanted.includes(name));
    });
    if (named) return named;
  }
  const words = episodeWords(torrent.season, torrent.episode);
  if (words.length > 0) {
    const numbered = videos.find(file => {
      const name = baseName(file.name).toLowerCase();
      return words.some(word => name.includes(word));
    });
    if (numbered) return numbered;
  }
  const at = torrent.fileIdx;
  if (at !== undefined) {
    const placed = files[at];
    if (placed && isVideo(placed)) return placed;
    const fromOne = at > 0 ? files[at - 1] : undefined;
    if (fromOne && isVideo(fromOne)) return fromOne;
    const byId = videos.find(file => file.id === String(at));
    if (byId) return byId;
  }
  return videos.reduce((best, file) => (file.size > best.size ? file : best), videos[0]);
};

/** The torrent's magnet link, with its trackers (not its DHT hints). */
export const magnetOf = (torrent: Torrent, name?: string) => {
  const trackers = torrent.sources
    .filter(source => !/^dht:/i.test(source))
    .map(source => source.replace(/^tracker:/i, "").trim())
    .filter((source, at, all) => source !== "" && all.indexOf(source) === at);
  return (
    `magnet:?xt=urn:btih:${torrent.infoHash}` +
    (name ? `&dn=${encodeURIComponent(name)}` : "") +
    trackers.map(source => `&tr=${encodeURIComponent(source)}`).join("")
  );
};

/** An info hash as 40 hex digits or 32 base32 letters, in lower case; undefined otherwise. */
export const infoHashOf = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const hash = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(hash) || /^[a-z2-7]{32}$/.test(hash) ? hash : undefined;
};
