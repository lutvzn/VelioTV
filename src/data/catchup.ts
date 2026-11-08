// Catch-up: the URL of a channel's recording from a given time (PLAN.md,
// Phase 6, step 2). Providers mark catch-up channels in one of several
// styles, as Kodi's IPTV Simple and TiviMate read them:
//
//   xtream, xc   Xtream's archive: /timeshift/<user>/<pass>/<minutes>/
//                <YYYY-MM-DD:HH-MM>/<id>.ts, from a channel URL such as
//                /live/<user>/<pass>/<id>.ts, in the server's time zone
//   default      catchup-source is the whole URL, with placeholders
//   append       catchup-source, with placeholders, after the channel's URL
//   shift        ?utc=<start>&lutc=<now> after the channel's URL
//   flussonic    /<name>/index.m3u8 becomes /<name>/index-<start>-<seconds>
//                .m3u8, and /<name>/mpegts becomes /<name>/timeshift_abs-
//                <start>.ts
//
// Placeholders, all in UTC: {utc} and ${start} the start in seconds,
// {utcend} and ${end} the end, {lutc}, ${now} and ${timestamp} now,
// {duration} and ${duration} the length in seconds ({duration:60} in
// minutes), {offset} how long ago it started ({offset:60} in minutes),
// {Y} {m} {d} {H} {M} {S} the start's date and time, {utc:YmdHMS} and
// {utcend:...} the same for either time, and ${(b)yyyy-MM-dd HH:mm:ss} and
// ${(e)...} the start's or end's, in Java's letters.

import type { PlaylistChannel } from "./types";

const DAY = 86_400_000;
/** How far back a channel that doesn't say keeps its catch-up. */
export const DEFAULT_CATCHUP_DAYS = 1;

/** How many days back a channel's catch-up reaches; 0 without catch-up. */
export const catchupDays = (channel: Pick<PlaylistChannel, "catchup">) =>
  channel.catchup ? (channel.catchup.days ?? DEFAULT_CATCHUP_DAYS) : 0;

/** The earliest moment a channel's catch-up reaches, or undefined without catch-up. */
export const catchupFrom = (channel: Pick<PlaylistChannel, "catchup">, now: number) => {
  const days = catchupDays(channel);
  return days > 0 ? now - days * DAY : undefined;
};

/** Whether a programme from `start` can be played from the archive: it has begun, and isn't too old. */
export const inArchive = (channel: Pick<PlaylistChannel, "catchup">, start: number, now: number) => {
  const from = catchupFrom(channel, now);
  return from !== undefined && start >= from && start < now;
};

export interface ArchiveRequest {
  /** Where to play from, in milliseconds since 1970. */
  from: number;
  /** Where the programme ends. */
  to: number;
  now: number;
  /** The Xtream server's time zone (IANA), for its archive's times; UTC if unknown. */
  timeZone?: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const seconds = (ms: number) => Math.floor(ms / 1000);

/** A time's parts, in UTC or in `timeZone`. */
const partsOf = (ms: number, timeZone?: string) => {
  if (timeZone && timeZone !== "UTC") {
    try {
      const format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const got: Record<string, string> = {};
      if (typeof format.formatToParts === "function") {
        for (const part of format.formatToParts(new Date(ms))) got[part.type] = part.value;
      } else {
        // Before Chromium 57 (the oldest TVs): "11/07/2026, 21:05:09".
        const found = /(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/.exec(format.format(new Date(ms)));
        if (!found) throw new Error("Unexpected date format");
        [, got.month, got.day, got.year, got.hour, got.minute, got.second] = found;
      }
      return {
        Y: got.year ?? "",
        m: got.month ?? "",
        d: got.day ?? "",
        H: got.hour === "24" ? "00" : (got.hour ?? ""),
        M: got.minute ?? "",
        S: got.second ?? "",
      };
    } catch {
      // An unknown time zone: UTC.
    }
  }
  const date = new Date(ms);
  return {
    Y: String(date.getUTCFullYear()),
    m: pad(date.getUTCMonth() + 1),
    d: pad(date.getUTCDate()),
    H: pad(date.getUTCHours()),
    M: pad(date.getUTCMinutes()),
    S: pad(date.getUTCSeconds()),
  };
};

/** "YmdHMS"-style letters, as in {utc:Y-m-d}. */
const strftime = (format: string, ms: number) => {
  const parts = partsOf(ms);
  return format.replace(/[YmdHMS]/g, letter =>
    letter === "Y" || letter === "m" || letter === "d" || letter === "H" || letter === "M" || letter === "S"
      ? parts[letter]
      : letter,
  );
};

/** Java's letters, as in ${(b)yyyy-MM-dd HH:mm:ss}. */
const javaTime = (format: string, ms: number) => {
  const parts = partsOf(ms);
  const letters: Record<string, string> = {
    yyyy: parts.Y,
    yy: parts.Y.slice(2),
    MM: parts.m,
    dd: parts.d,
    HH: parts.H,
    mm: parts.M,
    ss: parts.S,
  };
  return format.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, letter => letters[letter] ?? letter);
};

const divided = (value: number, by: string | undefined) => {
  const n = Number(by);
  return String(Math.floor(by && n > 0 ? value / n : value));
};

/** Fills in a catch-up template's placeholders. */
export const fillTemplate = (template: string, { from, to, now }: ArchiveRequest) => {
  const length = seconds(to) - seconds(from);
  const ago = seconds(now) - seconds(from);
  return template.replace(/\$?\{([^{}]*)\}/g, (whole, inner: string) => {
    const java = inner.match(/^\((b|e)\)(.+)$/);
    if (java) return javaTime(java[2], java[1] === "e" ? to : from);
    const [name, argument] = inner.split(/:(.*)/);
    switch (name) {
      case "utc":
      case "start":
        return argument ? strftime(argument, from) : String(seconds(from));
      case "utcend":
      case "end":
        return argument ? strftime(argument, to) : String(seconds(to));
      case "lutc":
      case "now":
      case "timestamp":
        return argument ? strftime(argument, now) : String(seconds(now));
      case "duration":
        return divided(length, argument);
      case "offset":
        return divided(ago, argument);
      case "Y":
      case "m":
      case "d":
      case "H":
      case "M":
      case "S":
        return partsOf(from)[name];
      default:
        return whole;
    }
  });
};

const withQuery = (url: string, query: string) => {
  if (!query) return url;
  if (query.startsWith("?") || query.startsWith("&")) {
    return url + (url.includes("?") ? `&${query.slice(1)}` : `?${query.slice(1)}`);
  }
  return url + query;
};

// /live/<user>/<pass>/<id>.<ext>, or without /live/.
const XTREAM_URL = /^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(\.\w+)?(?:\?.*)?$/;

const xtreamArchive = (url: string, request: ArchiveRequest) => {
  const match = url.match(XTREAM_URL);
  if (!match) return undefined;
  const [, server, user, password, id, ext] = match;
  const minutes = Math.max(1, Math.ceil((request.to - request.from) / 60_000));
  const p = partsOf(request.from, request.timeZone);
  const start = `${p.Y}-${p.m}-${p.d}:${p.H}-${p.M}`;
  return `${server}/timeshift/${user}/${password}/${minutes}/${start}/${id}${ext === ".m3u8" ? ".m3u8" : ".ts"}`;
};

const flussonicArchive = (url: string) => {
  const hls = url.match(/^(.*\/)([^/?]+)\.m3u8(\?.*)?$/);
  if (hls) return `${hls[1]}${hls[2]}-{utc}-{duration}.m3u8${hls[3] ?? ""}`;
  const ts = url.match(/^(.*\/)mpegts(\?.*)?$/);
  if (ts) return `${ts[1]}timeshift_abs-{utc}.ts${ts[2] ?? ""}`;
  return undefined;
};

/**
 * Where a recording asked for from `from` really starts: Xtream's archive
 * takes whole minutes, the others whole seconds.
 */
export const archiveStart = (channel: Pick<PlaylistChannel, "catchup">, from: number) => {
  const type = channel.catchup?.type.toLowerCase();
  const step = type === "xtream" || type === "xc" ? 60_000 : 1000;
  return Math.floor(from / step) * step;
};

/**
 * The URL that plays `channel`'s recording from `request.from`, or undefined
 * if the channel has no catch-up, or its style isn't one the app knows.
 */
export const archiveUrl = (
  channel: Pick<PlaylistChannel, "url" | "catchup">,
  request: ArchiveRequest,
): string | undefined => {
  const catchup = channel.catchup;
  if (!catchup) return undefined;
  const type = catchup.type.toLowerCase();
  const source = catchup.source?.trim();
  if (type === "xtream" || type === "xc") return xtreamArchive(channel.url, request);
  if (type === "flussonic" || type === "flussonic-hls" || type === "flussonic-ts" || type === "fs") {
    const template = flussonicArchive(channel.url);
    return template && fillTemplate(template, request);
  }
  if (type === "shift" || type === "timeshift") {
    return fillTemplate(withQuery(channel.url, source || "?utc={utc}&lutc={lutc}"), request);
  }
  if (!source) return undefined;
  // "default", or a style named some other way: a whole URL is the
  // recording's, anything else follows the channel's.
  if (/^https?:\/\//i.test(source)) return fillTemplate(source, request);
  return fillTemplate(withQuery(channel.url, source), request);
};
