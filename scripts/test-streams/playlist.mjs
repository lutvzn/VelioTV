// Writes the catalog as an M3U playlist and an XMLTV guide.

import { REQUIRED_REFERER, REQUIRED_USER_AGENT } from "./streams.mjs";
import { guideChannels, programmes } from "./catalog.mjs";

// The URL that plays a channel's test stream.
export const streamUrl = (base, channel) => {
  const prefix =
    channel.header === "referer"
      ? "/need-referer"
      : channel.header === "user-agent"
        ? "/need-user-agent"
        : "";
  const path = channel.hls ? `/hls/${channel.stream}/index.m3u8` : `/ts/${channel.stream}.ts`;
  return `${base}${prefix}${path}`;
};

export const logoUrl = (base, channel) => (channel.logo ? `${base}${channel.logo}` : "");

// M3U attribute values can't hold double quotes.
const attribute = value => String(value).replaceAll('"', "'");

// An extended M3U playlist (#EXTM3U with #EXTINF attributes), as IPTV
// providers serve it. `url` gives each channel's stream URL.
export const m3u = ({ base, channels, guideUrl, url = channel => streamUrl(base, channel) }) => {
  const lines = [`#EXTM3U url-tvg="${guideUrl}" x-tvg-url="${guideUrl}"`];
  for (const channel of channels) {
    const attributes = [
      ["tvg-id", channel.guideId ?? ""],
      ["tvg-name", channel.name],
      ["tvg-logo", logoUrl(base, channel)],
      ["tvg-chno", channel.number],
      ["group-title", channel.group],
    ];
    if (channel.archiveDays) {
      attributes.push(
        ["catchup", "append"],
        ["catchup-days", channel.archiveDays],
        ["catchup-source", "?utc={utc}&lutc={lutc}"],
      );
    }
    const text = attributes.map(([key, value]) => `${key}="${attribute(value)}"`).join(" ");
    lines.push(`#EXTINF:-1 ${text},${channel.name}`);
    if (channel.header === "referer") lines.push(`#EXTVLCOPT:http-referrer=${REQUIRED_REFERER}`);
    if (channel.header === "user-agent") lines.push(`#EXTVLCOPT:http-user-agent=${REQUIRED_USER_AGENT}`);
    lines.push(url(channel));
  }
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
  yield '<tv generator-info-name="TiviPlayer test streams">\n';
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
