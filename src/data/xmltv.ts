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

/** Where an element named `name` starts in `text`, from `from`, or -1. */
const findElement = (text: string, name: string, from: number) => {
  const open = `<${name}`;
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
  const at = findElement(block, name, from);
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

const elements = (block: string, name: string) => {
  const list: Element[] = [];
  for (let found = element(block, name); found; found = element(block, name, found.end)) list.push(found);
  return list;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "1.4.0/1" (xmltv_ns, counted from 0) to "S02E05". */
const episodeFromXmltvNs = (text: string) => {
  const [season, episode] = text.split(".").map(part => Number.parseInt(part.split("/")[0], 10));
  const s = Number.isFinite(season) ? `S${pad(season + 1)}` : "";
  const e = Number.isFinite(episode) ? `E${pad(episode + 1)}` : "";
  return s + e || undefined;
};

/**
 * XMLTV time, such as "20261102143000 +0100", to milliseconds since 1970.
 * Seconds, minutes and hours may be left out. Without a time zone, the time
 * is taken as `defaultOffsetMinutes` from UTC.
 */
export const parseXmltvTime = (value: string | undefined, defaultOffsetMinutes = 0): number | undefined => {
  if (!value) return undefined;
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
  /** Minutes from UTC for times with no time zone. */
  defaultOffsetMinutes?: number;
}

export class XmltvParser {
  channels = 0;
  programmes = 0;
  /** Programmes left out for having no channel, start time or title. */
  invalid = 0;

  private handlers: XmltvHandlers;
  private buffer = "";

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
    let channelAt = findElement(buffer, "channel", 0);
    let programmeAt = findElement(buffer, "programme", 0);
    for (;;) {
      if (channelAt !== -1 && channelAt < position) channelAt = findElement(buffer, "channel", position);
      if (programmeAt !== -1 && programmeAt < position) {
        programmeAt = findElement(buffer, "programme", position);
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
      if (buffer[tagEnd - 1] === "/") {
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
      const block = buffer.slice(start, end);
      const tag = buffer.slice(start, tagEnd + 1);
      if (isChannel) this.channel(block, tag);
      else this.programme(block, tag);
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

  private programme(block: string, tag: string) {
    const offset = this.handlers.defaultOffsetMinutes;
    const channel = attribute(tag, "channel");
    const start = parseXmltvTime(attribute(tag, "start"), offset);
    const title = element(block, "title")?.text;
    if (!channel || start === undefined || !title) {
      this.invalid++;
      return;
    }
    const programme: Programme = { channel, start, title };
    const stop = parseXmltvTime(attribute(tag, "stop"), offset);
    if (stop !== undefined && stop > start) programme.stop = stop;
    const subTitle = element(block, "sub-title")?.text;
    if (subTitle) programme.subTitle = subTitle;
    const description = element(block, "desc")?.text;
    if (description) programme.description = description;
    const categories = elements(block, "category")
      .map(category => category.text)
      .filter(Boolean);
    if (categories.length) programme.categories = categories;

    let episode: string | undefined;
    for (const number of elements(block, "episode-num")) {
      const system = attribute(number.tag, "system");
      if (system === "onscreen" && number.text) {
        episode = number.text;
        break;
      }
      if (system === "xmltv_ns" && !episode) episode = episodeFromXmltvNs(number.text);
    }
    if (episode) programme.episode = episode;
    const icon = element(block, "icon");
    const src = icon && attribute(icon.tag, "src");
    if (src) programme.icon = src;
    if (findElement(block, "new", 0) !== -1) programme.isNew = true;

    this.programmes++;
    this.handlers.onProgramme(programme);
  }
}
