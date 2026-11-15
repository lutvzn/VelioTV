// A streaming parser for M3U playlists, including the extended form:
//
//   #EXTM3U url-tvg="http://.../guide.xml.gz"
//   #EXTINF:-1 tvg-id="..." tvg-logo="..." group-title="...",Channel name
//   #EXTVLCOPT:http-referrer=...
//   http://.../stream.ts
//
// Feed it text with push() as it downloads, then call end().

import type { Catchup, PlaylistChannel, StreamHeaders } from "./types";

type Attributes = Record<string, string>;

// Character codes. Every line of a playlist comes through here, in workers
// built for ES5 (PLAN.md, Phase 8, step 4), so it reads codes rather than
// one-character strings, and loops by index rather than with for...of.
const SPACE = 32;
const TAB = 9;
const COMMA = 44;
const EQUALS = 61;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;

const isSpaceCode = (code: number) => code === SPACE || code === TAB;

/**
 * Reads the `key="value"` pairs and the title after them, from the text after
 * "#EXTINF:" (which starts with a duration) or after "#EXTM3U". It copes with
 * unquoted values, stray quotes inside values and commas inside quotes.
 */
export const parseAttributes = (text: string): { attributes: Attributes; title: string } => {
  const attributes: Attributes = {};
  const n = text.length;
  let i = 0;
  // The duration, such as "-1".
  for (let code = text.charCodeAt(0); i < n && !isSpaceCode(code) && code !== COMMA;) {
    code = text.charCodeAt(++i);
  }
  for (;;) {
    while (i < n && isSpaceCode(text.charCodeAt(i))) i++;
    if (i >= n) return { attributes, title: "" };
    if (text.charCodeAt(i) === COMMA) return { attributes, title: text.slice(i + 1).trim() };
    let k = i;
    for (let code = text.charCodeAt(k); k < n && code !== EQUALS && code !== COMMA && !isSpaceCode(code);) {
      code = text.charCodeAt(++k);
    }
    if (text.charCodeAt(k) !== EQUALS) {
      // A word with no value, such as the rest of a value broken by a stray
      // quote: skip it.
      i = k;
      continue;
    }
    const key = text.slice(i, k).toLowerCase();
    let j = k + 1;
    let value: string;
    const quote = text.charCodeAt(j);
    if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
      const end = text.indexOf(quote === DOUBLE_QUOTE ? '"' : "'", j + 1);
      value = text.slice(j + 1, end === -1 ? n : end);
      j = end === -1 ? n : end + 1;
    } else {
      let end = j;
      for (let code = text.charCodeAt(end); end < n && code !== COMMA && !isSpaceCode(code);) {
        code = text.charCodeAt(++end);
      }
      value = text.slice(j, end);
      j = end;
    }
    if (key) attributes[key] = value;
    i = j;
  }
};

/** Whether `line` starts with `tag`, such as "#EXTINF:", in any case. */
const startsWithTag = (line: string, tag: string) =>
  line.startsWith(tag) || line.slice(0, 11).toUpperCase().startsWith(tag);

const setHeader = (headers: StreamHeaders, name: string, value: string) => {
  const key = name.trim().toLowerCase();
  if (key === "user-agent" || key === "http-user-agent") headers.userAgent = value.trim();
  else if (key === "referer" || key === "referrer" || key === "http-referrer" || key === "http-referer") {
    headers.referer = value.trim();
  }
};

const decodeComponent = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const positiveNumber = (text: string | undefined) => {
  if (!text) return undefined;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

// #EXTINF attributes that give a stream's headers, in the order applied.
const HEADER_ATTRIBUTES = ["http-user-agent", "user-agent", "http-referrer", "http-referer", "referer"];

export class M3uParser {
  /** Guide URLs from the #EXTM3U line (url-tvg, x-tvg-url). */
  guideUrls: string[] = [];
  /** Channels read so far. */
  count = 0;

  private onChannel: (channel: PlaylistChannel) => void;
  private rest = "";
  private started = false;
  private info: { attributes: Attributes; title: string } | undefined;
  private group: string | undefined;
  private headers: StreamHeaders = {};

  constructor(onChannel: (channel: PlaylistChannel) => void) {
    this.onChannel = onChannel;
  }

  push(text: string) {
    const lines = (this.rest + text).split("\n");
    this.rest = lines.pop() ?? "";
    // oxlint-disable-next-line unicorn/no-for-loop -- see the character codes above
    for (let i = 0; i < lines.length; i++) this.line(lines[i]);
  }

  end() {
    if (this.rest) this.line(this.rest);
    this.rest = "";
  }

  private line(raw: string) {
    let line = raw.trim();
    if (!this.started) {
      if (line.startsWith("﻿")) line = line.slice(1).trim();
      if (line) this.started = true;
    }
    if (!line) return;
    if (line.charCodeAt(0) !== 35 /* # */) {
      this.channel(line);
      return;
    }
    if (startsWithTag(line, "#EXTINF:")) {
      this.info = parseAttributes(line.slice(8));
    } else if (startsWithTag(line, "#EXTM3U")) {
      const { attributes } = parseAttributes(line.slice(7));
      for (const key of ["url-tvg", "x-tvg-url", "tvg-url"]) {
        for (const url of attributes[key]?.split(",") ?? []) {
          const trimmed = url.trim();
          if (trimmed && !this.guideUrls.includes(trimmed)) this.guideUrls.push(trimmed);
        }
      }
    } else if (startsWithTag(line, "#EXTGRP:")) {
      this.group = line.slice(8).trim() || undefined;
    } else if (startsWithTag(line, "#EXTVLCOPT:")) {
      const option = line.slice(11);
      const equals = option.indexOf("=");
      if (equals > 0) setHeader(this.headers, option.slice(0, equals), option.slice(equals + 1));
    } else if (startsWithTag(line, "#EXTHTTP:")) {
      try {
        const values: unknown = JSON.parse(line.slice(9));
        if (values && typeof values === "object") {
          for (const [name, value] of Object.entries(values)) {
            if (typeof value === "string") setHeader(this.headers, name, value);
          }
        }
      } catch {
        // Not JSON: ignore it.
      }
    }
  }

  private channel(line: string) {
    const attributes = this.info?.attributes ?? {};
    const headers = this.headers;
    // Kodi-style headers after the URL: "http://...|User-Agent=x&Referer=y".
    let url = line;
    const pipe = line.indexOf("|");
    if (pipe !== -1) {
      url = line.slice(0, pipe);
      for (const pair of line.slice(pipe + 1).split("&")) {
        const equals = pair.indexOf("=");
        if (equals > 0) setHeader(headers, pair.slice(0, equals), decodeComponent(pair.slice(equals + 1)));
      }
    }
    // oxlint-disable-next-line unicorn/no-for-loop -- see the character codes above
    for (let i = 0; i < HEADER_ATTRIBUTES.length; i++) {
      const key = HEADER_ATTRIBUTES[i];
      if (attributes[key]) setHeader(headers, key, attributes[key]);
    }

    const name = this.info?.title || attributes["tvg-name"] || url;
    const channel: PlaylistChannel = { index: this.count++, name, url };
    const guideId = attributes["tvg-id"]?.trim();
    if (guideId) channel.guideId = guideId;
    if (attributes["tvg-name"]) channel.guideName = attributes["tvg-name"];
    const logo = attributes["tvg-logo"] || attributes.logo;
    if (logo) channel.logo = logo;
    const number = positiveNumber(attributes["tvg-chno"] || attributes["channel-number"]);
    if (number !== undefined) channel.number = number;
    const group = attributes["group-title"] || this.group;
    if (group) channel.group = group;

    const type = attributes.catchup || attributes["catchup-type"];
    const days = positiveNumber(attributes["catchup-days"] || attributes.timeshift || attributes["tvg-rec"]);
    if (type || days) {
      const catchup: Catchup = { type: type || "default" };
      if (days !== undefined) catchup.days = days;
      if (attributes["catchup-source"]) catchup.source = attributes["catchup-source"];
      channel.catchup = catchup;
    }
    if (headers.referer || headers.userAgent) channel.headers = headers;

    this.info = undefined;
    this.group = undefined;
    this.headers = {};
    this.onChannel(channel);
  }
}

/** Parses a whole playlist at once. */
export const parseM3u = (text: string) => {
  const channels: PlaylistChannel[] = [];
  const parser = new M3uParser(channel => channels.push(channel));
  parser.push(text);
  parser.end();
  return { channels, guideUrls: parser.guideUrls };
};
