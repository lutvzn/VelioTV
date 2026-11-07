// A mock Xtream Codes API, for live TV only (no films or series yet).
//
//   /player_api.php?username=&password=[&action=...]
//   /get.php?username=&password=&type=m3u_plus&output=ts   M3U playlist
//   /xmltv.php?username=&password=                         XMLTV guide
//   /live/<user>/<pass>/<stream_id>.ts|.m3u8               live stream
//   /timeshift/<user>/<pass>/<minutes>/<start>/<id>.ts     catch-up
//
// The streams redirect to the test streams, as many real servers redirect to
// another host. Catch-up plays the live stream.

import { programmesBetween } from "./catalog.mjs";
import { logoUrl, m3u, streamPath, xmltv } from "./playlist.mjs";

const HOUR = 3_600_000;

const pad = n => String(n).padStart(2, "0");
// Xtream's "2026-11-02 14:30:00", in UTC (the server_info time zone).
const dateTime = time => {
  const d = new Date(time);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
};
const seconds = time => String(Math.floor(time / 1000));
// btoa() rather than Buffer, so tests can run this in a browser.
const base64 = text => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const userInfo = (account, now) => ({
  username: account.username,
  password: account.password,
  message: "TiviPlayer test server",
  auth: 1,
  status: "Active",
  exp_date: seconds(now + 365 * 24 * HOUR),
  is_trial: "0",
  active_cons: "0",
  created_at: seconds(now - 30 * 24 * HOUR),
  max_connections: "2",
  allowed_output_formats: ["m3u8", "ts"],
});

const serverInfo = (host, now) => {
  const [hostname, port = "80"] = host.split(":");
  return {
    url: hostname,
    port,
    https_port: "",
    server_protocol: "http",
    rtmp_port: "",
    timezone: "UTC",
    timestamp_now: Math.floor(now / 1000),
    time_now: dateTime(now),
  };
};

const liveStream = (base, channel) => ({
  num: channel.number,
  name: channel.name,
  stream_type: "live",
  stream_id: channel.id,
  stream_icon: logoUrl(base, channel),
  epg_channel_id: channel.guideId,
  added: "1767225600",
  category_id: String(channel.groupId),
  category_ids: [channel.groupId],
  custom_sid: "",
  tv_archive: channel.archiveDays ? 1 : 0,
  direct_source: "",
  tv_archive_duration: channel.archiveDays,
});

const listing = (channel, p, now) => ({
  id: `${channel.id}${seconds(p.start)}`,
  epg_id: String(channel.id),
  title: base64(p.title),
  lang: "en",
  start: dateTime(p.start),
  end: dateTime(p.stop),
  description: base64(p.description),
  channel_id: channel.guideId,
  start_timestamp: seconds(p.start),
  stop_timestamp: seconds(p.stop),
  now_playing: p.start <= now && now < p.stop ? 1 : 0,
  has_archive:
    channel.archiveDays && p.stop <= now && p.start >= now - channel.archiveDays * 24 * HOUR ? 1 : 0,
});

// The JSON for a player_api.php request, exported for the app's tests.
// `ctx` has { account, base, host, now, window }.
export const playerApi = (url, ctx) => {
  const { account, base, now, window } = ctx;
  const { channels, groups } = account.catalog;
  const action = url.searchParams.get("action");
  const byId = () => channels.find(c => c.id === Number(url.searchParams.get("stream_id")));

  switch (action) {
    case null:
      return { user_info: userInfo(account, now), server_info: serverInfo(ctx.host, now) };
    case "get_live_categories":
      return groups.map(group => ({
        category_id: String(group.id),
        category_name: group.name,
        parent_id: 0,
      }));
    case "get_live_streams": {
      const category = url.searchParams.get("category_id");
      const list = category ? channels.filter(c => String(c.groupId) === category) : channels;
      return list.map(channel => liveStream(base, channel));
    }
    case "get_short_epg": {
      const channel = byId();
      if (!channel) return { epg_listings: [] };
      const limit = Number(url.searchParams.get("limit") || 4);
      const list = programmesBetween(channel, window, now, window.end).slice(0, limit);
      return { epg_listings: list.map(p => listing(channel, p, now)) };
    }
    case "get_simple_data_table": {
      const channel = byId();
      if (!channel) return { epg_listings: [] };
      const list = programmesBetween(channel, window, window.start, window.end);
      return { epg_listings: list.map(p => listing(channel, p, now)) };
    }
    case "get_vod_categories":
    case "get_vod_streams":
    case "get_series_categories":
    case "get_series":
      return [];
    default:
      return { error: `Unknown action ${action}` };
  }
};

const LIVE = [
  /^\/live\/([^/]+)\/([^/]+)\/(\d+)\.(ts|m3u8)$/,
  /^\/timeshift\/([^/]+)\/([^/]+)\/\d+\/[^/]+\/(\d+)\.(ts|m3u8)$/,
];

// Handles an Xtream request, or returns false if `url` isn't one.
// `ctx.accounts` maps "username:password" to { username, password, catalog }.
export const handleXtream = (req, res, url, ctx) => {
  const send = (status, body, type) => {
    ctx.send(res, status, body, type);
    return true;
  };
  const json = body => send(200, JSON.stringify(body), "application/json");
  const login = (username, password) => ctx.accounts.get(`${username}:${password}`);
  const account = login(url.searchParams.get("username"), url.searchParams.get("password"));
  const denied = () => send(401, "Wrong username or password\n");

  if (url.pathname === "/player_api.php") {
    // Real servers answer a wrong login with auth 0 and nothing else.
    if (!account) return json({ user_info: { auth: 0 } });
    return json(playerApi(url, { ...ctx, account, host: req.headers.host ?? "localhost" }));
  }
  if (url.pathname === "/get.php") {
    if (!account) return denied();
    const { username, password } = account;
    const output = url.searchParams.get("output") === "m3u8" ? "m3u8" : "ts";
    const body = m3u({
      base: ctx.base,
      channels: account.catalog.channels,
      guideUrl: `${ctx.base}/xmltv.php?username=${username}&password=${password}`,
      url: channel => `${ctx.base}/live/${username}/${password}/${channel.id}.${output}`,
    });
    return send(200, body, "audio/x-mpegurl");
  }
  if (url.pathname === "/xmltv.php") {
    if (!account) return denied();
    const chunks = xmltv({ base: ctx.base, channels: account.catalog.channels, window: ctx.window });
    return ctx.sendChunks(res, chunks, "application/xml");
  }

  const live = LIVE.map(pattern => url.pathname.match(pattern)).find(Boolean);
  if (!live) return false;
  const owner = login(live[1], live[2]);
  if (!owner) return denied();
  const channel = owner.catalog.channels.find(c => c.id === Number(live[3]));
  if (!channel) return send(404, "Unknown stream\n");
  const target = streamPath(channel, live[4] === "m3u8");
  res.writeHead(302, { Location: `${ctx.base}${target}`, "Access-Control-Allow-Origin": "*" });
  res.end();
  return true;
};
