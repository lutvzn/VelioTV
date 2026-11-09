// A streaming parser for XMLTV guides. It scans the text for <channel> and
// <programme> elements instead of building an XML document, which keeps
// memory flat and is fast on the TV (see PLAN.md, Phase 0 test 6). Feed it
// text with push() as it downloads.
//
// It imports only types, so Node can run it directly for benchmarks.

import type { GuideChannel, Programme } from "./types";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes XML entities and CDATA in element text or an attribute value. */
export const decodeXml = (text: string): string => {
  if (text.startsWith("<![CDATA[")) {
    const end = text.lastIndexOf("]]>");
    return text.slice(9, end === -1 ? undefined : end);
  }
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
};

const isSpaceCode = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;

/** The value of attribute `name` in an opening tag. */
const attribute = (tag: string, name: string): string | undefined => {
  const search = `${name}=`;
  for (let at = tag.indexOf(search); at !== -1; at = tag.indexOf(search, at + 1)) {
    if (!isSpaceCode(tag.charCodeAt(at - 1))) continue;
    const quote = tag[at + search.length];
    if (quote !== '"' && quote !== "'") return undefined;
    const start = at + search.length + 1;
    const end = tag.indexOf(quote, start);
    return end === -1 ? undefined : decodeXml(tag.slice(start, end));
  }
  return undefined;
};

/** Where an element opened by `open`, such as "<title", starts in `text`, from `from`, or -1. */
const findOpening = (text: string, open: string, from: number) => {
  for (let at = text.indexOf(open, from); at !== -1; at = text.indexOf(open, at + 1)) {
    const next = text.charCodeAt(at + open.length);
    if (isSpaceCode(next) || next === 62 /* > */ || next === 47 /* / */) return at;
  }
  return -1;
};

interface Element {
  tag: string;
  text: string;
  end: number;
}

/** The next element named `name` inside `block`, from `from`. */
const element = (block: string, name: string, from = 0): Element | undefined => {
  const at = findOpening(block, `<${name}`, from);
  if (at === -1) return undefined;
  const tagEnd = block.indexOf(">", at);
  if (tagEnd === -1) return undefined;
  const tag = block.slice(at, tagEnd + 1);
  if (block[tagEnd - 1] === "/") return { tag, text: "", end: tagEnd + 1 };
  const closing = `</${name}>`;
  const close = block.indexOf(closing, tagEnd);
  if (close === -1) return undefined;
  return { tag, text: decodeXml(block.slice(tagEnd + 1, close).trim()), end: close + closing.length };
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "1.4.0/1" (xmltv_ns, counted from 0) to "S02E05". */
const episodeFromXmltvNs = (text: string) => {
  // parseInt() stops at the "." and "/" that end each part.
  const season = Number.parseInt(text, 10);
  const dot = text.indexOf(".");
  const episode = dot === -1 ? Number.NaN : Number.parseInt(text.slice(dot + 1), 10);
  const s = Number.isFinite(season) ? `S${pad(season + 1)}` : "";
  const e = Number.isFinite(episode) ? `E${pad(episode + 1)}` : "";
  return s + e || undefined;
};

// Days from 1970-01-01 to a date of the proleptic Gregorian calendar, with
// `month` from 1 to 12 and `day` allowed past the month's end, as Date.UTC
// allows it (Howard Hinnant's days_from_civil).
const daysFromCivil = (year: number, month: number, day: number) => {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
};

const digitAt = (text: string, at: number) => {
  const code = text.charCodeAt(at) - 48;
  return code >= 0 && code <= 9 ? code : -1;
};

const twoDigits = (text: string, at: number) => {
  const tens = digitAt(text, at);
  const ones = digitAt(text, at + 1);
  return tens === -1 || ones === -1 ? -1 : tens * 10 + ones;
};

// The usual forms, "20261102143000 +0100" and "20261102143000", read with
// arithmetic; undefined for anything else, which parseXmltvTime() reads the
// slow way. The two give the same answer.
const quickXmltvTime = (text: string, defaultOffsetMinutes: number): number | undefined => {
  const length = text.length;
  if (length !== 14 && length !== 20) return undefined;
  const century = twoDigits(text, 0);
  const year = century * 100 + twoDigits(text, 2);
  const month = twoDigits(text, 4);
  const day = twoDigits(text, 6);
  const hours = twoDigits(text, 8);
  const minutes = twoDigits(text, 10);
  const seconds = twoDigits(text, 12);
  // Date.UTC() reads years 0 to 99 as 1900 to 1999, and lets months run over.
  if (century < 1 || month < 1 || month > 12 || day < 0 || hours < 0 || minutes < 0 || seconds < 0) {
    return undefined;
  }
  let offset = defaultOffsetMinutes;
  if (length === 20) {
    const sign = text.charCodeAt(15);
    const zoneHours = twoDigits(text, 16);
    const zoneMinutes = twoDigits(text, 18);
    if (text.charCodeAt(14) !== 32 || (sign !== 43 && sign !== 45) || zoneHours < 0 || zoneMinutes < 0) {
      return undefined;
    }
    offset = zoneHours * 60 + zoneMinutes;
    if (sign === 45) offset = -offset;
  }
  const days = daysFromCivil(year, month, day);
  return ((days * 24 + hours) * 60 + minutes - offset) * 60_000 + seconds * 1000;
};

/**
 * XMLTV time, such as "20261102143000 +0100", to milliseconds since 1970.
 * Seconds, minutes and hours may be left out. Without a time zone, the time
 * is taken as `defaultOffsetMinutes` from UTC.
 */
export const parseXmltvTime = (value: string | undefined, defaultOffsetMinutes = 0): number | undefined => {
  if (!value) return undefined;
  const quick = quickXmltvTime(value, defaultOffsetMinutes);
  if (quick !== undefined) return quick;
  const text = value.trim();
  let digits = 0;
  while (digits < 14 && text.charCodeAt(digits) >= 48 && text.charCodeAt(digits) <= 57) digits++;
  if (digits < 8) return undefined;
  const part = (from: number) => (digits >= from + 2 ? Number(text.slice(from, from + 2)) : 0);
  let offset = defaultOffsetMinutes;
  const zone = text.slice(digits).trim();
  if ((zone[0] === "+" || zone[0] === "-") && zone.length >= 5) {
    const minutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5));
    if (Number.isFinite(minutes)) offset = zone[0] === "-" ? -minutes : minutes;
  } else if (zone === "Z" || zone.startsWith("UTC") || zone.startsWith("GMT")) {
    offset = 0;
  }
  const time = Date.UTC(
    Number(text.slice(0, 4)),
    Number(text.slice(4, 6)) - 1,
    Number(text.slice(6, 8)),
    part(8),
    part(10),
    part(12),
  );
  return Number.isFinite(time) ? time - offset * 60_000 : undefined;
};

export interface XmltvHandlers {
  onChannel?: (channel: GuideChannel) => void;
  onProgramme: (programme: Programme) => void;
  /**
   * The channel to give a programme, from its guide channel, or undefined
   * to leave the programme out unread (counted in `unwanted`). Without it,
   * every programme keeps its guide channel.
   */
  channelOf?: (id: string) => string | undefined;
  /** Leave out categories, icons and "new" flags, which take extra work. */
  skipExtras?: boolean;
  /** Minutes from UTC for times with no time zone. */
  defaultOffsetMinutes?: number;
}

// A programme's child elements that are read.
const TITLE = 1;
const SUB_TITLE = 2;
const DESC = 3;
const CATEGORY = 4;
const EPISODE_NUM = 5;
const ICON = 6;
const NEW = 7;

const NAMES = ["", "title", "sub-title", "desc", "category", "episode-num", "icon", "new"];

const endsName = (code: number) => code === 62 /* > */ || code === 47 /* / */ || isSpaceCode(code);

/** Which child element is at `at`, just after its "<", or 0 for none read. */
const childAt = (text: string, at: number) => {
  let child: number;
  switch (text.charCodeAt(at)) {
    case 116 /* t */:
      child = TITLE;
      break;
    case 115 /* s */:
      child = SUB_TITLE;
      break;
    case 100 /* d */:
      child = DESC;
      break;
    case 99 /* c */:
      child = CATEGORY;
      break;
    case 101 /* e */:
      child = EPISODE_NUM;
      break;
    case 105 /* i */:
      child = ICON;
      break;
    case 110 /* n */:
      child = NEW;
      break;
    default:
      return 0;
  }
  const name = NAMES[child];
  return text.startsWith(name, at) && endsName(text.charCodeAt(at + name.length)) ? child : 0;
};

const CLOSING = ["", "</title>", "</sub-title>", "</desc>", "</category>", "</episode-num>", "</icon>"];

export class XmltvParser {
  channels = 0;
  programmes = 0;
  /** Programmes left out for having no channel, start time or title. */
  invalid = 0;
  /** Programmes left out by `channelOf`. */
  unwanted = 0;

  private handlers: XmltvHandlers;
  private buffer = "";
  private lastId?: string;
  private lastChannel?: string;

  constructor(handlers: XmltvHandlers) {
    this.handlers = handlers;
  }

  push(text: string) {
    const buffer = this.buffer + text;
    let position = 0;
    // Where the next of each element starts, or -1 for none in the buffer.
    // Searching again only once one is passed keeps this linear: a guide's
    // channels all come first, so searching for the next channel at every
    // programme would rescan the whole buffer.
    let channelAt = findOpening(buffer, "<channel", 0);
    let programmeAt = findOpening(buffer, "<programme", 0);
    for (;;) {
      if (channelAt !== -1 && channelAt < position) channelAt = findOpening(buffer, "<channel", position);
      if (programmeAt !== -1 && programmeAt < position) {
        programmeAt = findOpening(buffer, "<programme", position);
      }
      const isChannel = channelAt !== -1 && (programmeAt === -1 || channelAt < programmeAt);
      const start = isChannel ? channelAt : programmeAt;
      if (start === -1) break;
      const tagEnd = buffer.indexOf(">", start);
      if (tagEnd === -1) {
        position = start;
        break;
      }
      let end: number;
      const empty = buffer.charCodeAt(tagEnd - 1) === 47; /* / */
      if (empty) {
        end = tagEnd + 1;
      } else {
        const closing = isChannel ? "</channel>" : "</programme>";
        const close = buffer.indexOf(closing, tagEnd);
        if (close === -1) {
          position = start;
          break;
        }
        end = close + closing.length;
      }
      const tag = buffer.slice(start, tagEnd + 1);
      if (isChannel) this.channel(buffer.slice(start, end), tag);
      else this.programme(buffer, tag, empty ? end : tagEnd + 1, end);
      position = end;
    }
    // Keep only what may be the start of an unfinished element.
    this.buffer = buffer.slice(position);
    if (channelAt === -1 && programmeAt === -1 && this.buffer.length > 64) {
      // No element starts here, but one may begin in the last few characters.
      this.buffer = this.buffer.slice(-16);
    }
  }

  private channel(block: string, tag: string) {
    const id = attribute(tag, "id");
    if (!id) return;
    const channel: GuideChannel = { id };
    const name = element(block, "display-name")?.text;
    if (name) channel.name = name;
    const icon = element(block, "icon");
    const src = icon && attribute(icon.tag, "src");
    if (src) channel.icon = src;
    this.channels++;
    this.handlers.onChannel?.(channel);
  }

  // The programme whose opening tag is `tag`, with its children from `from`
  // up to `end` in `text`. Its children are read in one pass, giving the
  // same as searching the programme for each by name: the first title,
  // sub-title, desc and icon, every category and episode-num, and whether
  // there's a new.
  private programme(text: string, tag: string, from: number, end: number) {
    const { handlers } = this;
    const id = attribute(tag, "channel");
    let channel = id;
    if (id && handlers.channelOf) {
      if (id !== this.lastId) {
        this.lastId = id;
        this.lastChannel = handlers.channelOf(id);
      }
      channel = this.lastChannel;
      if (channel === undefined) {
        this.unwanted++;
        return;
      }
    }
    const start = parseXmltvTime(attribute(tag, "start"), handlers.defaultOffsetMinutes);
    if (!channel || start === undefined) {
      this.invalid++;
      return;
    }
    const extras = !handlers.skipExtras;
    let title: string | undefined;
    let subTitle: string | undefined;
    let description: string | undefined;
    let categories: string[] | undefined;
    let episode: string | undefined;
    let onScreen = false;
    let icon: string | undefined;
    let isNew = false;
    // The first-only children met so far, as bits.
    let met = 0;
    // Where the next category and episode-num may start: as when searching
    // for each in turn, one inside another is passed over.
    let nextCategory = 0;
    let nextEpisode = 0;

    let at = text.indexOf("<", from);
    while (at !== -1 && at < end) {
      const child = childAt(text, at + 1);
      const nameEnd = at + 1 + NAMES[child].length;
      let wanted: boolean;
      if (child === CATEGORY) wanted = extras && at >= nextCategory;
      else if (child === EPISODE_NUM) wanted = at >= nextEpisode;
      else
        wanted = child !== 0 && (met & (1 << child)) === 0 && (extras || (child !== ICON && child !== NEW));
      if (!wanted) {
        at = text.indexOf("<", nameEnd);
        continue;
      }
      met |= 1 << child;
      if (child === NEW) {
        isNew = true;
        at = text.indexOf("<", nameEnd);
        continue;
      }
      const tagEnd = text.indexOf(">", nameEnd);
      if (tagEnd === -1 || tagEnd >= end) break;
      // The text, up to the closing tag: mostly the next tag, so found by
      // looking for that; otherwise, as with CDATA, by searching for it.
      let content = "";
      let next = tagEnd + 1;
      let closed = true;
      if (text.charCodeAt(tagEnd - 1) !== 47 /* / */) {
        const closing = CLOSING[child];
        const firstTag = text.indexOf("<", tagEnd + 1);
        const close =
          firstTag !== -1 && text.startsWith(closing, firstTag)
            ? firstTag
            : text.indexOf(closing, tagEnd + 1);
        if (close === -1 || close + closing.length > end) closed = false;
        else {
          content = decodeXml(text.slice(tagEnd + 1, close).trim());
          // With nothing between, the search goes on after the closing tag.
          if (close === firstTag) next = close + closing.length;
          if (child === CATEGORY) nextCategory = close + closing.length;
          else if (child === EPISODE_NUM) nextEpisode = close + closing.length;
        }
      } else if (child === CATEGORY) nextCategory = tagEnd + 1;
      else if (child === EPISODE_NUM) nextEpisode = tagEnd + 1;
      if (!closed) {
        // As a search by name would, give up on this name.
        if (child === CATEGORY) nextCategory = end;
        else if (child === EPISODE_NUM) nextEpisode = end;
      } else if (child === TITLE) title = content;
      else if (child === SUB_TITLE) subTitle = content;
      else if (child === DESC) description = content;
      else if (child === ICON) icon = attribute(text.slice(at, tagEnd + 1), "src") || undefined;
      else if (child === CATEGORY) {
        if (content) (categories ??= []).push(content);
      } else if (!onScreen) {
        const system = attribute(text.slice(at, tagEnd + 1), "system");
        if (system === "onscreen" && content) {
          episode = content;
          onScreen = true;
        } else if (system === "xmltv_ns" && !episode) episode = episodeFromXmltvNs(content);
      }
      at = text.indexOf("<", next);
    }

    if (!title) {
      this.invalid++;
      return;
    }
    const programme: Programme = { channel, start, title };
    const stop = parseXmltvTime(attribute(tag, "stop"), handlers.defaultOffsetMinutes);
    if (stop !== undefined && stop > start) programme.stop = stop;
    if (subTitle) programme.subTitle = subTitle;
    if (description) programme.description = description;
    if (categories) programme.categories = categories;
    if (episode) programme.episode = episode;
    if (icon) programme.icon = icon;
    if (isNew) programme.isNew = true;
    this.programmes++;
    handlers.onProgramme(programme);
  }
}
