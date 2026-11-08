// Writes the catalog as an M3U playlist and an XMLTV guide.

import { REQUIRED_REFERER, REQUIRED_USER_AGENT } from "./streams.mjs";
import { guideChannels, programmes } from "./catalog.mjs";

// The path under /fail/ (server.mjs) for a channel that fails on purpose.
const FAULT_PATHS = {
  cut: "/fail/cut/40",
  stall: "/fail/stall/40",
  missing: "/fail/status/404",
  outage: "/fail/outage",
};

// A channel's stream path, as raw TS or HLS, failing if the channel should.
export const streamPath = (channel, hls = channel.hls) =>
  `${FAULT_PATHS[channel.fault] ?? ""}${hls ? `/hls/${channel.stream}/index.m3u8` : `/ts/${channel.stream}.ts`}`;

// The URL that plays a channel's test stream.
export const streamUrl = (base, channel) => {
  const prefix =
    channel.header === "referer"
      ? "/need-referer"
      : channel.header === "user-agent"
        ? "/need-user-agent"
        : "";
  return `${base}${prefix}${streamPath(channel)}`;
};

export const logoUrl = (base, channel) => (channel.logo ? `${base}${channel.logo}` : "");

/**
 * The plain playlist's catch-up channels take turns at each catch-up style
 * (PLAN.md, Phase 6, step 2); Flussonic needs a URL of its own shape, so
 * channels that need a header use append instead.
 */
export const CATCHUP_STYLES = ["default", "append", "shift", "flussonic"];
export const catchupStyle = channel => {
  if (!channel.archiveDays) return null;
  const style = CATCHUP_STYLES[Math.floor(channel.number / 10) % CATCHUP_STYLES.length];
  return style === "flussonic" && channel.header ? "append" : style;
};

// A Flussonic-style live URL: /fs/<stream>/index.m3u8 for HLS, /fs/<stream>/mpegts for raw TS.
const flussonicUrl = (base, channel) =>
  `${base}/fs/${channel.stream}/${channel.hls ? "index.m3u8" : "mpegts"}`;

// The catch-up attributes for a style.
const catchupAttributes = (base, channel, style) => {
  const days = ["catchup-days", channel.archiveDays];
  if (style === "default") {
    return [
      ["catchup", "default"],
      days,
      ["catchup-source", `${base}/archive/${channel.id}/{Y}-{m}-{d}/{H}{M}{S}/{duration:60}.ts`],
    ];
  }
  if (style === "append") return [["catchup", "append"], days, ["catchup-source", "?utc={utc}&lutc={lutc}"]];
  return [["catchup", style], days];
};

// M3U attribute values can't hold double quotes.
const attribute = value => String(value).replaceAll('"', "'");

// An extended M3U playlist (#EXTM3U with #EXTINF attributes), as IPTV
// providers serve it. `url` gives each channel's stream URL, `catchup` each
// catch-up channel's style, and `extra` lines to add at the end.
export const m3u = ({ base, channels, guideUrl, url, catchup = catchupStyle, extra = [] }) => {
  const lines = [guideUrl ? `#EXTM3U url-tvg="${guideUrl}" x-tvg-url="${guideUrl}"` : "#EXTM3U"];
  for (const channel of channels) {
    const attributes = [
      ["tvg-id", channel.guideId ?? ""],
      ["tvg-name", channel.name],
      ["tvg-logo", logoUrl(base, channel)],
      ["tvg-chno", channel.number],
      ["group-title", channel.group],
    ];
    const style = channel.archiveDays ? catchup(channel) : null;
    if (style) attributes.push(...catchupAttributes(base, channel, style));
    const text = attributes.map(([key, value]) => `${key}="${attribute(value)}"`).join(" ");
    lines.push(`#EXTINF:-1 ${text},${channel.name}`);
    if (channel.header === "referer") lines.push(`#EXTVLCOPT:http-referrer=${REQUIRED_REFERER}`);
    if (channel.header === "user-agent") lines.push(`#EXTVLCOPT:http-user-agent=${REQUIRED_USER_AGENT}`);
    if (url) lines.push(url(channel));
    else lines.push(style === "flussonic" ? flussonicUrl(base, channel) : streamUrl(base, channel));
  }
  lines.push(...extra);
  return `${lines.join("\n")}\n`;
};

const escapeXml = text =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const pad = n => String(n).padStart(2, "0");

// XMLTV time: "20261102143000 +0100", in the channel's own time zone.
const xmltvTime = (time, offsetMinutes) => {
  const d = new Date(time + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = Math.abs(offsetMinutes);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} ` +
    `${sign}${pad(Math.floor(offset / 60))}${pad(offset % 60)}`
  );
};

const programmeXml = (channel, p) => {
  const parts = [
    `<programme start="${xmltvTime(p.start, channel.timeZone)}" stop="${xmltvTime(p.stop, channel.timeZone)}" channel="${escapeXml(channel.guideId)}">`,
    `<title lang="en">${escapeXml(p.title)}</title>`,
  ];
  if (p.subTitle) parts.push(`<sub-title lang="en">${escapeXml(p.subTitle)}</sub-title>`);
  parts.push(
    `<desc lang="en">${escapeXml(p.description)}</desc>`,
    `<category lang="en">${p.category}</category>`,
  );
  if (p.season) {
    parts.push(
      `<episode-num system="xmltv_ns">${p.season - 1}.${p.episode - 1}.</episode-num>`,
      `<episode-num system="onscreen">S${pad(p.season)}E${pad(p.episode)}</episode-num>`,
    );
  }
  if (p.isNew) parts.push("<new />");
  parts.push("</programme>\n");
  return parts.join("");
};

// An XMLTV guide, as chunks of text: the channels first, then each channel's
// programmes. It is generated as it is sent, since 10k channels make several
// hundred megabytes.
export function* xmltv({ base, channels, window }) {
  const listed = guideChannels(channels);
  yield '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
  yield '<tv generator-info-name="Velio test streams">\n';
  let chunk = "";
  for (const channel of listed) {
    chunk += `<channel id="${escapeXml(channel.guideId)}"><display-name lang="en">${escapeXml(channel.name)}</display-name>`;
    if (channel.logo) chunk += `<icon src="${logoUrl(base, channel)}" />`;
    chunk += "</channel>\n";
    if (chunk.length > 65_536) {
      yield chunk;
      chunk = "";
    }
  }
  yield chunk;
  for (const channel of listed) {
    chunk = "";
    for (const p of programmes(channel, window)) chunk += programmeXml(channel, p);
    yield chunk;
  }
  yield "</tv>\n";
}
