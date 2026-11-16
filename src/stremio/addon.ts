// Stremio add-ons (PLAN.md, "Stremio add-ons"): what an add-on's manifest
// says it has, the addresses to ask it, and its answers read into the app's
// own types. An add-on is a web service: GET <base>/manifest.json, then
// <base>/<resource>/<type>/<id>[/<extra>].json for catalogs, metas,
// streams and subtitles. Everything it sends is read loosely, keeping what
// fits and leaving the rest, as add-ons differ.

import { ensureFetch } from "../polyfills/fetch";
import { heightOf, sizeOf } from "./streamText";

ensureFetch();

export type AddonResource = "catalog" | "meta" | "stream" | "subtitles";

export interface AddonCatalog {
  type: string;
  id: string;
  name: string;
  /** Can be asked with search=… */
  search: boolean;
  /** Can only be asked with search=…, so isn't a group of its own. */
  searchOnly: boolean;
  /** Can be asked for more with skip=… */
  paged: boolean;
}

export interface AddonManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  logo?: string;
  /** Which resources, for which types and id prefixes (undefined: any). */
  resources: { name: string; types?: string[]; idPrefixes?: string[] }[];
  types: string[];
  idPrefixes?: string[];
  catalogs: AddonCatalog[];
  /** Asks to be set up on its own site first; it may answer nothing until then. */
  needsSetup?: boolean;
}

/** A title in a catalog, or its details from a meta. */
export interface AddonMeta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  plot?: string;
  year?: number;
  rating?: number;
  genres?: string[];
  durationMs?: number;
  director?: string;
  cast?: string;
  /** A series' episodes. */
  videos?: AddonVideo[];
}

export interface AddonVideo {
  /** The id to ask streams for, such as "tt0000001:1:2". */
  id: string;
  season: number;
  episode: number;
  title: string;
  plot?: string;
  thumbnail?: string;
  released?: number;
  /** Streams the add-on lists in the episode itself, used when its stream answer has none. */
  streams?: AddonStream[];
}

export interface AddonStream {
  url: string;
  /** The add-on's name for it, such as its quality. */
  name: string;
  /** More about it, on up to a few lines. */
  description: string;
  userAgent?: string;
  /** Streams of a series with the same group go on from one episode to the next. */
  bingeGroup?: string;
  /** Subtitles that come with this stream. */
  subtitles: AddonSubtitle[];
  /** Its name says DTS or TrueHD sound, and no other the TV plays (`silentSound`). */
  silent?: true;
  /** The file's name, as `behaviorHints.filename` gives it. */
  filename?: string;
  /** The picture's height its text names, such as 2160 for 4K (src/stremio/streamText.ts). */
  height?: number;
  /** The file's size in bytes, from `behaviorHints.videoSize` or its text. */
  sizeBytes?: number;
}

export interface AddonSubtitle {
  id: string;
  url: string;
  /** As the add-on gives it, such as "eng" or "pt-BR". */
  language: string;
}

/** What streams an add-on had that the TV can't play, to say why there are none. */
export interface StreamsRead {
  streams: AddonStream[];
  /** Torrents, YouTube ids and links to open elsewhere. */
  unplayable: number;
  /** Streams that need a Referer, which no engine can send. */
  needReferer: number;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 2000) =>
  typeof value === "string" ? value.trim().slice(0, max) : typeof value === "number" ? String(value) : "";
const optional = (value: unknown, max?: number) => text(value, max) || undefined;
const texts = (value: unknown, max = 50): string[] =>
  Array.isArray(value)
    ? value
        .slice(0, max)
        .map(item => text(item, 200))
        .filter(Boolean)
    : [];
const isWebUrl = (value: string) => /^https?:\/\/[^\s/]+/i.test(value);
const webUrl = (value: unknown) => {
  const url = text(value, 4096);
  return isWebUrl(url) ? url : undefined;
};
const count = (value: unknown) => {
  const n = typeof value === "number" ? value : Number.parseInt(text(value), 10);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
};

/** The add-on's address, which requests go under: its manifest's, without /manifest.json. */
export const addonBase = (manifestUrl: string) => {
  const [path, query = ""] = manifestUrl.split("?");
  const base = path.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
  // A query in the manifest's address (some add-ons keep their settings there) goes on each request.
  return { base, query: query ? `?${query}` : "" };
};

export const readManifest = (value: unknown): AddonManifest => {
  if (!isObject(value)) throw new Error("The add-on's manifest isn't an object");
  const id = text(value.id, 200);
  const name = text(value.name, 200);
  if (!id || !name) throw new Error("The add-on's manifest has no id or name");
  const types = texts(value.types);
  const idPrefixes = Array.isArray(value.idPrefixes) ? texts(value.idPrefixes, 100) : undefined;
  const resources = (Array.isArray(value.resources) ? value.resources : []).flatMap(item => {
    if (typeof item === "string") return [{ name: item }];
    if (!isObject(item) || !text(item.name)) return [];
    const resource: AddonManifest["resources"][number] = { name: text(item.name) };
    if (Array.isArray(item.types)) resource.types = texts(item.types);
    if (Array.isArray(item.idPrefixes)) resource.idPrefixes = texts(item.idPrefixes, 100);
    return [resource];
  });
  const catalogs = (Array.isArray(value.catalogs) ? value.catalogs : []).slice(0, 100).flatMap(item => {
    if (!isObject(item)) return [];
    const type = text(item.type, 100);
    const catalogId = text(item.id, 200);
    if (!type || !catalogId) return [];
    // Extras as the protocol has them now (extra: [{name, isRequired}]) or
    // as older add-ons wrote them (extraSupported, extraRequired).
    const extras = Array.isArray(item.extra) ? item.extra.filter(isObject) : [];
    const supported = new Set([...extras.map(extra => text(extra.name)), ...texts(item.extraSupported)]);
    const required = new Set([
      ...extras.filter(extra => extra.isRequired === true).map(extra => text(extra.name)),
      ...texts(item.extraRequired),
    ]);
    // A catalog that needs something other than a search, such as a genre, isn't shown.
    const needsOther = [...required].some(extra => extra !== "search");
    if (needsOther) return [];
    return [
      {
        type,
        id: catalogId,
        name: text(item.name, 200) || catalogId,
        search: supported.has("search"),
        searchOnly: required.has("search"),
        paged: supported.has("skip"),
      },
    ];
  });
  const manifest: AddonManifest = { id, name, resources, types, catalogs };
  if (idPrefixes) manifest.idPrefixes = idPrefixes;
  const version = optional(value.version, 50);
  if (version) manifest.version = version;
  const description = optional(value.description, 1000);
  if (description) manifest.description = description;
  const logo = webUrl(value.logo);
  if (logo) manifest.logo = logo;
  const hints = isObject(value.behaviorHints) ? value.behaviorHints : {};
  if (hints.configurationRequired === true) manifest.needsSetup = true;
  return manifest;
};

/** Whether the add-on answers `resource` for this type and id. */
export const supports = (manifest: AddonManifest, resource: AddonResource, type: string, id: string) =>
  manifest.resources.some(item => {
    if (item.name !== resource) return false;
    const types = item.types ?? manifest.types;
    if (types.length > 0 && !types.includes(type)) return false;
    const prefixes = item.idPrefixes ?? manifest.idPrefixes;
    return !prefixes || prefixes.length === 0 || prefixes.some(prefix => id.startsWith(prefix));
  });

/** Whether the add-on has catalogs at all (the resource or, as older add-ons do, only the list). */
export const hasCatalogs = (manifest: AddonManifest) =>
  manifest.catalogs.length > 0 &&
  (manifest.resources.length === 0 || manifest.resources.some(item => item.name === "catalog"));

const extraPath = (extras: [string, string | number | undefined][]) => {
  const parts = extras
    .filter((extra): extra is [string, string | number] => extra[1] !== undefined && extra[1] !== "")
    .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `/${parts.join("&")}` : "";
};

export const resourceUrl = (
  manifestUrl: string,
  resource: AddonResource,
  type: string,
  id: string,
  extras: [string, string | number | undefined][] = [],
) => {
  const { base, query } = addonBase(manifestUrl);
  return `${base}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPath(extras)}.json${query}`;
};

export const catalogUrl = (
  manifestUrl: string,
  catalog: Pick<AddonCatalog, "type" | "id">,
  options: { skip?: number; search?: string } = {},
) =>
  resourceUrl(manifestUrl, "catalog", catalog.type, catalog.id, [
    ["search", options.search],
    ["skip", options.skip || undefined],
  ]);

const yearOf = (value: unknown) => {
  const match = text(value).match(/\b(18|19|20)\d\d\b/);
  return match ? Number(match[0]) : undefined;
};
const ratingOf = (value: unknown) => {
  const n = typeof value === "number" ? value : Number.parseFloat(text(value));
  return Number.isFinite(n) && n > 0 && n <= 10 ? Math.round(n * 10) / 10 : undefined;
};
/** "120 min", "2h 5min", "1h", or minutes as a number. */
const durationOf = (value: unknown) => {
  if (typeof value === "number") return value > 0 ? value * 60_000 : undefined;
  const found = text(value).toLowerCase();
  const hours = /(\d+)\s*h/.exec(found);
  const minutes = /(\d+)\s*m/.exec(found);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  if (total > 0) return total * 60_000;
  const plain = Number.parseInt(found, 10);
  return Number.isFinite(plain) && plain > 0 ? plain * 60_000 : undefined;
};
const names = (value: unknown) => {
  const list = typeof value === "string" ? [text(value, 200)] : texts(value, 20);
  return list.length > 0 ? list.join(", ") : undefined;
};
const timeOf = (value: unknown) => {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readVideo = (value: unknown): AddonVideo | undefined => {
  if (!isObject(value)) return undefined;
  const id = text(value.id, 500);
  const season = count(value.season);
  const episode = count(value.episode ?? value.number);
  if (!id || season === undefined || episode === undefined) return undefined;
  const video: AddonVideo = { id, season, episode, title: text(value.title ?? value.name, 300) };
  const plot = optional(value.overview ?? value.description, 2000);
  if (plot) video.plot = plot;
  const thumbnail = webUrl(value.thumbnail);
  if (thumbnail) video.thumbnail = thumbnail;
  const released = timeOf(value.released ?? value.firstAired);
  if (released !== undefined) video.released = released;
  if (Array.isArray(value.streams)) {
    const { streams } = readStreams({ streams: value.streams.slice(0, 50) });
    if (streams.length > 0) video.streams = streams;
  }
  return video;
};

/** A catalog's item or a meta's details; undefined if it has no id or name. */
export const readMeta = (value: unknown, fallbackType?: string): AddonMeta | undefined => {
  if (!isObject(value)) return undefined;
  const id = text(value.id, 500);
  const name = text(value.name, 300);
  const type = text(value.type, 100) || fallbackType || "";
  if (!id || !name || !type) return undefined;
  const meta: AddonMeta = { id, type, name };
  const poster = webUrl(value.poster);
  if (poster) meta.poster = poster;
  const background = webUrl(value.background);
  if (background) meta.background = background;
  const plot = optional(value.description, 3000);
  if (plot) meta.plot = plot;
  const year = yearOf(value.releaseInfo) ?? yearOf(value.year) ?? yearOf(value.released);
  if (year) meta.year = year;
  const rating = ratingOf(value.imdbRating);
  if (rating) meta.rating = rating;
  const genres = texts(value.genres ?? value.genre, 10);
  if (genres.length > 0) meta.genres = genres;
  const durationMs = durationOf(value.runtime);
  if (durationMs) meta.durationMs = durationMs;
  const director = names(value.director);
  if (director) meta.director = director;
  const cast = names(value.cast);
  if (cast) meta.cast = cast;
  if (Array.isArray(value.videos)) {
    const videos = value.videos
      .slice(0, 5000)
      .map(readVideo)
      .filter((video): video is AddonVideo => video !== undefined)
      // Season 0 is specials, after the rest. A fresh array; older TVs lack toSorted().
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort((a, b) => (a.season || 1e6) - (b.season || 1e6) || a.episode - b.episode);
    if (videos.length > 0) meta.videos = videos;
  }
  return meta;
};

export const readCatalog = (value: unknown, type: string): AddonMeta[] => {
  const metas = isObject(value) && Array.isArray(value.metas) ? value.metas : [];
  const seen = new Set<string>();
  return metas
    .slice(0, 1000)
    .map(item => readMeta(item, type))
    .filter((meta): meta is AddonMeta => {
      if (!meta || seen.has(meta.id)) return false;
      seen.add(meta.id);
      return true;
    });
};

export const readMetaAnswer = (value: unknown, type: string) =>
  isObject(value) ? readMeta(value.meta, type) : undefined;

const readSubtitle = (value: unknown, at: number): AddonSubtitle | undefined => {
  if (!isObject(value)) return undefined;
  const url = webUrl(value.url);
  if (!url) return undefined;
  return { id: text(value.id, 200) || `${at}`, url, language: text(value.lang, 50) || "und" };
};

export const readSubtitles = (list: unknown): AddonSubtitle[] =>
  (Array.isArray(list) ? list : [])
    .slice(0, 200)
    .map(readSubtitle)
    .filter((subtitle): subtitle is AddonSubtitle => subtitle !== undefined);

export const readSubtitlesAnswer = (value: unknown) => readSubtitles(isObject(value) ? value.subtitles : []);

/** Header names are matched as the server would: without regard to case. */
const header = (headers: unknown, name: string) => {
  if (!isObject(headers)) return undefined;
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) return text(headers[key], 1000);
  return undefined;
};

// Words in a release's name, after something that isn't a letter or digit,
// and before something that isn't a letter (so "DTS-HD", "DDP5.1").
const word = (words: string) => new RegExp(`(?:^|[^a-z0-9])(?:${words})(?![a-z])`, "i");
const SILENT = word("dts(?:[-. :]?(?:hd|ma|x|es))?|true-?hd");
const HEARD = word("aac|e?-?ac-?3|dd\\+|ddp|dd|opus|mp3");

/**
 * Whether a stream's name and description say its sound is DTS or TrueHD
 * only, which Samsung TVs play as silence, with no audio track to choose
 * (PLAN.md, "Debrid add-ons"). Debrid add-ons name the file's formats there.
 * A file that also has AAC, AC-3, E-AC-3 or Opus plays that track instead.
 */
export const silentSound = (words: string) => SILENT.test(words) && !HEARD.test(words);

export const readStreams = (value: unknown): StreamsRead => {
  const list = isObject(value) && Array.isArray(value.streams) ? value.streams : [];
  const read: StreamsRead = { streams: [], unplayable: 0, needReferer: 0 };
  for (const item of list.slice(0, 500)) {
    if (!isObject(item)) continue;
    const url = webUrl(item.url);
    if (!url) {
      if (item.infoHash || item.ytId || item.externalUrl || item.url) read.unplayable++;
      continue;
    }
    const hints = isObject(item.behaviorHints) ? item.behaviorHints : {};
    const request = isObject(hints.proxyHeaders) ? hints.proxyHeaders.request : undefined;
    if (header(request, "referer")) {
      read.needReferer++;
      continue;
    }
    // "title" is the older name for the description.
    const description = text(item.description ?? item.title, 1000);
    const stream: AddonStream = {
      url,
      name: text(item.name, 200),
      description,
      subtitles: readSubtitles(item.subtitles),
    };
    const userAgent = header(request, "user-agent");
    if (userAgent) stream.userAgent = userAgent;
    const binge = optional(hints.bingeGroup, 200);
    if (binge) stream.bingeGroup = binge;
    const filename = text(hints.filename, 500);
    if (filename) stream.filename = filename;
    if (silentSound(`${stream.name}\n${description}\n${filename}`)) stream.silent = true;
    const height = heightOf([stream.name, description, filename]);
    if (height !== undefined) stream.height = height;
    const size =
      typeof hints.videoSize === "number" && hints.videoSize > 0
        ? Math.floor(hints.videoSize)
        : sizeOf([description, stream.name]);
    if (size !== undefined) stream.sizeBytes = size;
    read.streams.push(stream);
  }
  return read;
};

/** Asks for `url` and reads its answer, giving up after `timeoutMs`; throws on an error status. */
const fetchWithin = async <T>(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The add-on didn't answer in time")), timeoutMs);
  });
  try {
    const response = await Promise.race([fetcher(url), timeout]);
    if (!response.ok) throw new Error(`The add-on answered ${response.status}`);
    return await Promise.race([read(response), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Asks an add-on for JSON. */
export const getJson = (url: string, fetcher: typeof fetch, timeoutMs = 15_000): Promise<unknown> =>
  fetchWithin(url, fetcher, timeoutMs, response => response.json() as Promise<unknown>);

/** Downloads a file, such as subtitles. */
export const getBytes = (url: string, fetcher: typeof fetch, timeoutMs = 20_000) =>
  fetchWithin(url, fetcher, timeoutMs, response => response.arrayBuffer());
