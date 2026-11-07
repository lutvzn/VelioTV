// An Xtream Codes client, for live TV: the account, the live categories and
// channels (player_api.php), and the guide, which comes as XMLTV from
// xmltv.php and goes through the same parser as any other guide.
//
// Xtream servers differ in their JSON: the same field can be a number on one
// and a string on another, so every field is read loosely.

import { readText } from "./stream";
import type { PlaylistChannel } from "./types";

export interface XtreamLogin {
  /** Such as "http://example.com:8080"; a pasted player_api.php URL works too. */
  server: string;
  username: string;
  password: string;
  /** The stream format to play; by default TS, if the account allows it. */
  output?: "ts" | "m3u8";
}

export interface XtreamAccount {
  status?: string;
  /** When the account expires, in milliseconds since 1970. */
  expiresAt?: number;
  maxConnections?: number;
  activeConnections?: number;
  isTrial?: boolean;
  /** The stream formats the account allows, such as "ts" and "m3u8". */
  formats: string[];
  /** The server's time zone, such as "Europe/London", which its catch-up times are in. */
  timeZone?: string;
}

type Json = Record<string, unknown>;

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
const number = (value: unknown) => {
  const n = typeof value === "number" ? value : Number.parseFloat(text(value));
  return Number.isFinite(n) ? n : undefined;
};
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;

/** The server's base URL, without a trailing slash or a pasted API path. */
export const normalizeServer = (server: string) => {
  let url = server.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/(player_api|get|xmltv)\.php.*$/i, "").replace(/\/+$/, "");
};

const query = (login: XtreamLogin) =>
  `username=${encodeURIComponent(login.username)}&password=${encodeURIComponent(login.password)}`;

export const playerApiUrl = (login: XtreamLogin, action?: string) =>
  `${normalizeServer(login.server)}/player_api.php?${query(login)}${action ? `&action=${action}` : ""}`;

/** The account's full guide, as XMLTV. */
export const xtreamGuideUrl = (login: XtreamLogin) =>
  `${normalizeServer(login.server)}/xmltv.php?${query(login)}`;

export const xtreamStreamUrl = (login: XtreamLogin, streamId: string, output: "ts" | "m3u8") => {
  const path = [login.username, login.password].map(encodeURIComponent).join("/");
  return `${normalizeServer(login.server)}/live/${path}/${streamId}.${output}`;
};

const getJson = async (fetcher: typeof fetch, url: string, onBytes?: (bytes: number) => void) => {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Xtream server answered HTTP ${response.status}`);
  if (!response.body) throw new Error("Xtream server sent an empty response");
  // Read as text in pieces, for progress and in case it's gzipped.
  const pieces: string[] = [];
  for await (const piece of readText(response.body, onBytes)) pieces.push(piece);
  const body = pieces.join("");
  try {
    const value: unknown = JSON.parse(body);
    return value;
  } catch {
    throw new Error(`Xtream server sent something other than JSON: ${body.slice(0, 80)}`);
  }
};

/** Logs in, or throws if the server refuses. */
export const xtreamAccount = async (login: XtreamLogin, fetcher: typeof fetch): Promise<XtreamAccount> => {
  const reply = await getJson(fetcher, playerApiUrl(login));
  const user = isObject(reply) && isObject(reply.user_info) ? reply.user_info : undefined;
  if (!user || number(user.auth) !== 1) {
    throw new Error("Xtream login failed: wrong username or password, or the account has ended");
  }
  const status = text(user.status);
  if (status && status.toLowerCase() !== "active") throw new Error(`Xtream account is ${status}`);
  const account: XtreamAccount = {
    formats: Array.isArray(user.allowed_output_formats) ? user.allowed_output_formats.map(text) : [],
  };
  if (status) account.status = status;
  const expires = number(user.exp_date);
  if (expires) account.expiresAt = expires * 1000;
  const max = number(user.max_connections);
  if (max !== undefined) account.maxConnections = max;
  const active = number(user.active_cons);
  if (active !== undefined) account.activeConnections = active;
  if (user.is_trial !== undefined) account.isTrial = number(user.is_trial) === 1;
  const server = isObject(reply) && isObject(reply.server_info) ? reply.server_info : undefined;
  const timeZone = text(server?.timezone);
  if (timeZone) account.timeZone = timeZone;
  return account;
};

/** The account's live channels, in the server's order, with their groups. */
export const xtreamLiveChannels = async (
  login: XtreamLogin,
  account: XtreamAccount,
  fetcher: typeof fetch,
  onBytes?: (bytes: number) => void,
): Promise<PlaylistChannel[]> => {
  const [categories, streams] = await Promise.all([
    getJson(fetcher, playerApiUrl(login, "get_live_categories"), onBytes),
    getJson(fetcher, playerApiUrl(login, "get_live_streams"), onBytes),
  ]);
  const groups = new Map<string, string>();
  if (Array.isArray(categories)) {
    for (const category of categories) {
      if (isObject(category)) groups.set(text(category.category_id), text(category.category_name));
    }
  }
  if (!Array.isArray(streams)) throw new Error("Xtream server sent no channel list");

  const allowed = account.formats;
  const output =
    login.output ??
    (allowed.length === 0 || allowed.includes("ts") ? "ts" : allowed.includes("m3u8") ? "m3u8" : "ts");
  const channels: PlaylistChannel[] = [];
  for (const stream of streams) {
    if (!isObject(stream)) continue;
    const id = text(stream.stream_id);
    const name = text(stream.name);
    if (!id || !name) continue;
    const channel: PlaylistChannel = {
      index: channels.length,
      name,
      url: xtreamStreamUrl(login, id, output),
      providerId: id,
    };
    const guideId = text(stream.epg_channel_id);
    if (guideId) channel.guideId = guideId;
    const logo = text(stream.stream_icon);
    if (logo) channel.logo = logo;
    const num = number(stream.num);
    if (num !== undefined && num > 0) channel.number = num;
    const group = groups.get(text(stream.category_id));
    if (group) channel.group = group;
    if (number(stream.tv_archive) === 1) {
      const days = number(stream.tv_archive_duration);
      channel.catchup = days ? { type: "xtream", days } : { type: "xtream" };
    }
    channels.push(channel);
  }
  return channels;
};
