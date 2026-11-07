// A channel's key within its source, the same each time the source imports
// again, so the user's edits (favourites, hidden, locked, moved) stay on the
// right channel (PLAN.md, Phase 5, step 1). In order of trust:
//
// - the provider's own id for it, such as Xtream's stream_id;
// - the stream id at the end of an Xtream-style URL, as most M3U links from
//   Xtream panels have ("/live/<user>/<password>/<id>.ts"), which outlasts a
//   new password;
// - its name, ignoring case and spacing.
//
// URLs aren't keys as such: many carry a token that changes at each refresh.
// Channels sharing a key add their group, then a count, in playlist order.

interface Keyed {
  name: string;
  url: string;
  group?: string;
  providerId?: string;
}

const isDigits = (text: string) => {
  if (text.length === 0) return false;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code < 48 || code > 57) return false;
  }
  return true;
};

/**
 * The stream id ending an Xtream-style URL: a path's last segment, digits
 * with an optional extension, after at least two others (user and password).
 * Read by hand: a regular expression took 88 ms for 10,000 channels on the TV.
 */
export const xtreamStreamId = (url: string): string | undefined => {
  let end = url.length;
  const query = url.indexOf("?");
  if (query >= 0) end = query;
  const hash = url.indexOf("#");
  if (hash >= 0 && hash < end) end = hash;
  const scheme = url.indexOf("://");
  const pathStart = url.indexOf("/", scheme >= 0 ? scheme + 3 : 0);
  if (pathStart < 0 || pathStart >= end) return undefined;
  const last = url.lastIndexOf("/", end - 1);
  // Two segments before the last, both inside the path.
  const second = url.lastIndexOf("/", last - 1);
  if (second <= pathStart) return undefined;
  const segment = url.slice(last + 1, end);
  const dot = segment.indexOf(".");
  const id = dot < 0 ? segment : segment.slice(0, dot);
  return isDigits(id) && second - pathStart > 1 && last - second > 1 ? id : undefined;
};

/** A channel's key before telling apart channels that share it. */
export const baseKey = (channel: Keyed) => {
  if (channel.providerId) return `i:${channel.providerId}`;
  const streamId = xtreamStreamId(channel.url);
  if (streamId) return `i:${streamId}`;
  return `n:${channel.name.trim().replace(/\s+/g, " ").toLowerCase()}`;
};

/** Every channel's key, unique within the list. */
export const channelKeys = (channels: readonly Keyed[]): string[] => {
  const taken = new Set<string>();
  return channels.map(channel => {
    const base = baseKey(channel);
    if (!taken.has(base)) {
      taken.add(base);
      return base;
    }
    const grouped = `${base}|${channel.group ?? ""}`;
    let key = grouped;
    for (let count = 2; taken.has(key); count++) key = `${grouped}#${count}`;
    taken.add(key);
    return key;
  });
};
