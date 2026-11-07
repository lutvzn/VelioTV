// Made-up channels and guide data for testing sources. The M3U playlist, the
// XMLTV guide and the mock Xtream and Stalker APIs all describe the same
// channels. Everything comes from fixed seeds, so the same channel count
// always gives the same data; only the guide's dates move, since it starts
// at midnight UTC yesterday.
//
// The data includes the awkward cases real playlists have: channels with no
// guide, two channels sharing one guide, missing logos, names with commas,
// quotes and accents, channels that need a Referer or User-Agent, catch-up
// channels, and guides in other time zones.

import { STREAMS } from "./streams.mjs";

const DAY = 86_400_000;
const MINUTE = 60_000;

// FNV-1a, to turn a string into a seed.
export const hash = text => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

// mulberry32: a small, fast, seeded random number generator.
export const random = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

const SYLLABLES =
  "ka lo mi ra ven tor sil bri dun mar pel quo zan fe rin tal gor nu bel cas wy dra lum ost".split(" ");
const capital = word => word[0].toUpperCase() + word.slice(1);
const word = rand => {
  let text = "";
  for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) text += pick(rand, SYLLABLES);
  return text;
};
const words = (rand, count) => {
  const list = [];
  for (let i = 0; i < count; i++) list.push(word(rand));
  return list;
};

const REGIONS = [
  "Northvale",
  "Eastmere",
  "Southport",
  "Westholm",
  "Midland",
  "Highcliff",
  "Lowbridge",
  "Riverton",
  "Stonebay",
  "Ashford",
];
const CATEGORIES = [
  "News",
  "Sports",
  "Movies",
  "Kids",
  "Music",
  "Documentary",
  "Entertainment",
  "Lifestyle",
  "Series",
  "Local",
  "Religion",
  "Shopping",
];
const VARIANTS = ["", "", " HD", " HD", " FHD", " SD", " 4K"];
const SHOW_LENGTHS = [15, 30, 30, 30, 60, 60, 60, 60, 90, 120];
// Some channels' guides are written in local time, to test time zones.
const TIME_ZONES = [0, 0, 0, 60, 0, -300, 0, 330];

// Splits `count` channels over the groups, with a few big groups and many
// small ones, as real playlists have.
const groupSizes = (count, groups) => {
  const rand = random(7);
  const weights = groups.map((_, i) => (0.5 + rand()) / ((i % 17) + 1) ** 0.8);
  const total = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map(w => (count * w) / total);
  const sizes = exact.map(Math.floor);
  let left = count - sizes.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - sizes[i], i]).toSorted((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k++, left--) sizes[order[k % order.length][1]]++;
  return sizes;
};

const channelName = (number, category, rand) => {
  // A few names with characters that trip up parsers.
  if (number % 997 === 0) return `Smith, Jones & Sons ${category}`;
  if (number % 991 === 0) return `Café Ünïcode 日本 ${category}`;
  if (number % 983 === 0) return `The "Quoted" ${category} Channel`;
  return `${capital(word(rand))} ${category}`;
};

// Channels 125, 375, 625 and 875 of every 1,000 play streams that fail on
// purpose (server.mjs, /fail/), named for what they do, raw TS only.
const FAULTS = {
  cut: "cuts off every 40 s",
  stall: "stalls every 40 s",
  missing: "answers 404",
  outage: "goes down in an outage",
};
const faultOf = number => (number % 250 === 125 ? Object.keys(FAULTS)[Math.floor(number / 250) % 4] : null);

const buildChannels = count => {
  // About one group per 10 channels, up to 120.
  const groups = REGIONS.flatMap(region => CATEGORIES.map(category => ({ region, category }))).slice(
    0,
    Math.max(1, Math.ceil(count / 10)),
  );
  const sizes = groupSizes(count, groups);
  const channels = [];
  const usedGroups = [];
  groups.forEach((group, g) => {
    if (sizes[g] === 0) return;
    const groupId = usedGroups.length + 1;
    usedGroups.push({ id: groupId, name: `${group.region} | ${group.category}` });
    for (let k = 0; k < sizes[g]; k++) {
      const number = channels.length + 1;
      const rand = random(hash(`channel-${number}`));
      const previous = channels.at(-1);
      // Every 50th channel is the SD copy of the one before it, sharing its
      // guide; every 20th has no guide at all.
      const copy = number % 50 === 1 && previous?.guideId && previous.groupId === groupId;
      const name = copy
        ? previous.name.replace(/( HD| FHD| 4K)?$/, " SD")
        : channelName(number, group.category, rand);
      channels.push({
        number,
        id: number,
        name:
          (copy ? name : name + pick(rand, VARIANTS)) +
          (faultOf(number) ? ` (${FAULTS[faultOf(number)]})` : ""),
        groupId,
        group: usedGroups.at(-1).name,
        category: group.category,
        guideId: copy ? previous.guideId : number % 20 === 7 ? null : `ch${number}.test`,
        timeZone: TIME_ZONES[number % TIME_ZONES.length],
        logo: number % 33 === 0 ? null : `/logo/${count}/${number}.svg`,
        stream: STREAMS[number % STREAMS.length].id,
        hls: number % 4 === 0 && !faultOf(number),
        header: number % 500 === 250 ? "referer" : number % 500 === 499 ? "user-agent" : null,
        fault: faultOf(number),
        archiveDays: number % 10 === 0 ? 3 : 0,
      });
    }
  });
  return { channels, groups: usedGroups };
};

const catalogs = new Map();

// The channels and groups for a channel count, with the last few cached.
export const catalog = count => {
  if (!catalogs.has(count)) {
    if (catalogs.size >= 4) catalogs.delete(catalogs.keys().next().value);
    catalogs.set(count, buildChannels(count));
  }
  return catalogs.get(count);
};

// The channels that have a guide, one per guide id.
export const guideChannels = channels => {
  const seen = new Set();
  return channels.filter(channel => {
    if (!channel.guideId || seen.has(channel.guideId)) return false;
    seen.add(channel.guideId);
    return true;
  });
};

// The guide covers `days` days, starting at midnight UTC yesterday.
export const guideWindow = (days, now = Date.now()) => {
  const start = Math.floor(now / DAY) * DAY - DAY;
  return { start, end: start + days * DAY };
};

// Each guide channel has its own set of shows, repeated through the week.
const shows = rand =>
  Array.from({ length: 12 }, () => ({
    title: words(rand, 1 + Math.floor(rand() * 3))
      .map(capital)
      .join(" "),
    series: rand() < 0.6,
  }));

// A guide channel's programmes, back to back from the start of the window to
// its end. The same guide id always gives the same programmes.
export function* programmes(channel, window) {
  const rand = random(hash(channel.guideId));
  const list = shows(rand);
  const episodes = new Map();
  let start = window.start - Math.floor(rand() * 60) * MINUTE;
  while (start < window.end) {
    const show = pick(rand, list);
    const stop = start + pick(rand, SHOW_LENGTHS) * MINUTE;
    // How many times the show has been on before.
    const aired = episodes.get(show) ?? 0;
    episodes.set(show, aired + 1);
    const description = words(rand, 8 + Math.floor(rand() * 18));
    description[0] = capital(description[0]);
    const programme = {
      start,
      stop,
      title: show.title,
      subTitle: show.series && rand() < 0.5 ? capital(words(rand, 2).join(" ")) : null,
      description: `${description.join(" ")}.`,
      category: channel.category,
      season: show.series ? 1 + Math.floor(aired / 20) : null,
      episode: show.series ? 1 + (aired % 20) : null,
      isNew: rand() < 0.1,
    };
    if (stop > window.start) yield programme;
    start = stop;
  }
}

// The programmes of a channel that overlap `from`..`to`.
export const programmesBetween = (channel, window, from, to) => {
  const list = [];
  if (!channel.guideId) return list;
  for (const programme of programmes(channel, window)) {
    if (programme.start >= to) break;
    if (programme.stop > from) list.push(programme);
  }
  return list;
};

// A channel logo: a coloured square with the channel's initials.
export const logoSvg = channel => {
  const hue = hash(channel.name) % 360;
  const initials = channel.name
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .replace(/[^\p{L}\p{N}]/gu, "");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">`,
    `<rect width="256" height="256" rx="32" fill="hsl(${hue} 60% 40%)"/>`,
    `<text x="128" y="150" font-family="sans-serif" font-size="96" font-weight="bold" fill="#fff" text-anchor="middle">${initials}</text>`,
    `<text x="128" y="220" font-family="sans-serif" font-size="32" fill="#fff" text-anchor="middle">${channel.number}</text>`,
    `</svg>`,
  ].join("");
};
