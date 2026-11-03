// A mock Stalker (Ministra) portal, for live TV only. A client sends its MAC
// address in a cookie, gets a token from the handshake, then sends it as
// `Authorization: Bearer <token>`:
//
//   /stalker_portal/server/load.php, /portal.php or /server/load.php
//     ?type=stb&action=handshake            -> { js: { token } }
//     ?type=stb&action=get_profile
//     ?type=itv&action=get_genres
//     ?type=itv&action=get_all_channels
//     ?type=itv&action=get_ordered_list&genre=<id|*>&p=<page>
//     ?type=itv&action=create_link&cmd=<channel cmd>
//     ?type=itv&action=get_short_epg&ch_id=<id>&size=<n>
//     ?type=itv&action=get_epg_info&period=<hours>
//     ?type=epg&action=get_simple_data_table&ch_id=<id>&date=<YYYY-MM-DD>&p=<page>
//
// As on real portals, a channel's `cmd` isn't playable: create_link turns it
// into a stream URL with a one-off token, and /stalker/play/ answers only
// tokens it gave out. Real portals differ in many details; this follows the
// common ones.

import { randomBytes } from "node:crypto";
import { programmesBetween } from "./catalog.mjs";
import { logoUrl } from "./playlist.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PAGE_ITEMS = 14;
const EPG_PAGE_ITEMS = 10;
const PATHS = new Set(["/stalker_portal/server/load.php", "/portal.php", "/server/load.php"]);

const sessions = new Map(); // token -> account
const links = new Map(); // link token -> channel stream path

const pad = n => String(n).padStart(2, "0");
const dateTime = time => {
  const d = new Date(time);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
};

const macFrom = req => req.headers.cookie?.match(/(?:^|;\s*)mac=([^;]+)/)?.[1];
const token = () => randomBytes(16).toString("hex").toUpperCase();

const channelItem = (base, channel) => ({
  id: String(channel.id),
  name: channel.name,
  number: String(channel.number),
  cmd: `ffrt http://localhost/ch/${channel.id}`,
  tv_genre_id: String(channel.groupId),
  logo: logoUrl(base, channel),
  xmltv_id: channel.guideId ?? "",
  censored: 0,
  hd: channel.name.includes("HD") ? 1 : 0,
  tv_archive: channel.archiveDays ? 1 : 0,
  tv_archive_duration: channel.archiveDays * 24,
  use_http_tmp_link: "1",
});

const epgItem = (channel, p, now) => ({
  id: `${channel.id}${Math.floor(p.start / 1000)}`,
  ch_id: String(channel.id),
  time: dateTime(p.start),
  time_to: dateTime(p.stop),
  duration: (p.stop - p.start) / 1000,
  name: p.title,
  descr: p.description,
  real_id: `${channel.id}_${Math.floor(p.start / 1000)}`,
  category: p.category,
  start_timestamp: Math.floor(p.start / 1000),
  stop_timestamp: Math.floor(p.stop / 1000),
  mark_archive: channel.archiveDays && p.stop <= now && p.start >= now - channel.archiveDays * DAY ? 1 : 0,
});

const page = (list, number, size) => ({
  total_items: list.length,
  max_page_items: size,
  selected_item: 0,
  cur_page: number,
  data: list.slice((number - 1) * size, number * size),
});

const itv = (action, url, ctx, account) => {
  const { base, now, window } = ctx;
  const { channels, groups } = account.catalog;
  const param = name => url.searchParams.get(name);
  const byId = () => channels.find(c => c.id === Number(param("ch_id")));

  switch (action) {
    case "get_genres":
      return [
        { id: "*", title: "All", alias: "all", censored: 0 },
        ...groups.map(group => ({ id: String(group.id), title: group.name, alias: group.name, censored: 0 })),
      ];
    case "get_all_channels":
      return { total_items: channels.length, data: channels.map(channel => channelItem(base, channel)) };
    case "get_ordered_list": {
      const genre = param("genre") ?? "*";
      const list = genre === "*" ? channels : channels.filter(c => String(c.groupId) === genre);
      return page(
        list.map(channel => channelItem(base, channel)),
        Number(param("p") || 1),
        PAGE_ITEMS,
      );
    }
    case "create_link": {
      const id = Number(param("cmd")?.match(/\/ch\/(\d+)/)?.[1]);
      const channel = channels.find(c => c.id === id);
      if (!channel) return { id: null, cmd: "" };
      const linkToken = token();
      // Keep the newest links only, as real portals expire them.
      if (links.size > 10_000) links.delete(links.keys().next().value);
      links.set(linkToken, channel.hls ? `/hls/${channel.stream}/index.m3u8` : `/ts/${channel.stream}.ts`);
      const extension = channel.hls ? "m3u8" : "ts";
      return {
        id: String(channel.id),
        cmd: `ffmpeg ${base}/stalker/play/${channel.id}.${extension}?token=${linkToken}`,
      };
    }
    case "get_short_epg": {
      const channel = byId();
      if (!channel) return [];
      const size = Number(param("size") || 10);
      return programmesBetween(channel, window, now, window.end)
        .slice(0, size)
        .map(p => epgItem(channel, p, now));
    }
    case "get_epg_info": {
      const hours = Math.min(Number(param("period") || 3), 24);
      const data = {};
      for (const channel of channels) {
        const list = programmesBetween(channel, window, now, now + hours * HOUR);
        if (list.length) data[channel.id] = list.map(p => epgItem(channel, p, now));
      }
      return { data };
    }
    default:
      return [];
  }
};

const epg = (action, url, ctx, account) => {
  if (action !== "get_simple_data_table") return [];
  const channel = account.catalog.channels.find(c => c.id === Number(url.searchParams.get("ch_id")));
  if (!channel) return page([], 1, EPG_PAGE_ITEMS);
  const day = Date.parse(`${url.searchParams.get("date")}T00:00:00Z`) || Math.floor(ctx.now / DAY) * DAY;
  const list = programmesBetween(channel, ctx.window, day, day + DAY).map(p => epgItem(channel, p, ctx.now));
  return page(list, Number(url.searchParams.get("p") || 1), EPG_PAGE_ITEMS);
};

const load = (req, url, ctx) => {
  const type = url.searchParams.get("type");
  const action = url.searchParams.get("action");
  const account = ctx.macs.get(macFrom(req)?.toUpperCase());

  if (type === "stb" && action === "handshake") {
    const sessionToken = token();
    if (account) sessions.set(sessionToken, account);
    return { js: { token: sessionToken, random: token().toLowerCase() } };
  }

  const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  const session = bearer && sessions.get(bearer);
  // Portals answer a request without a valid token with this plain text.
  if (!session) return null;

  if (type === "stb" && action === "get_profile") {
    return {
      js: { id: String(session.id), name: session.name, mac: session.mac, status: 0, timezone: "UTC" },
    };
  }
  if (type === "stb") return { js: [] };
  if (type === "watchdog") return { js: { data: { msgs: 0 } } };
  if (type === "itv") return { js: itv(action, url, ctx, session) };
  if (type === "epg") return { js: epg(action, url, ctx, session) };
  return { js: [] };
};

// Handles a Stalker request, or returns false if `url` isn't one. `ctx.macs`
// maps an upper-case MAC address to { id, name, mac, catalog }.
export const handleStalker = (req, res, url, ctx) => {
  if (url.pathname === "/c/" || url.pathname === "/stalker_portal/c/") {
    ctx.send(res, 200, "<!doctype html><title>Stalker portal</title>\n", "text/html");
    return true;
  }
  if (PATHS.has(url.pathname)) {
    const body = load(req, url, ctx);
    if (body) ctx.send(res, 200, JSON.stringify(body), "application/json");
    else ctx.send(res, 200, "Authorization failed.");
    return true;
  }
  const play = url.pathname.match(/^\/stalker\/play\/\d+\.(ts|m3u8)$/);
  if (play) {
    const target = links.get(url.searchParams.get("token") ?? "");
    if (!target) {
      ctx.send(res, 403, "Unknown or missing link token\n");
      return true;
    }
    res.writeHead(302, { Location: `${ctx.base}${target}`, "Access-Control-Allow-Origin": "*" });
    res.end();
    return true;
  }
  return false;
};
