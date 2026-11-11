// Copied from VelioPlatform's packages/sync-core/src/events.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// Live updates (PLAN.md, "VelioTV pulling"; Phase 5). A TV keeps a WebSocket
// to GET /v1/events, and the account's Durable Object sends "rev N" when it
// connects and after each change, so the TV pulls within seconds rather than
// on its 15-minute timer. Polling stays the fallback: the socket only says
// when to pull, never what changed.
//
// A browser's WebSocket can't send an Authorization header, so the TV sends
// its device token as a second subprotocol, "bearer.<token>". It stays out
// of the address, and so out of logs. The server answers with
// EVENTS_PROTOCOL only.
//
// What the TV does:
//
//   connect      new WebSocket(eventsUrl(site), eventsProtocols(token))
//   "rev N"      pull, unless it already has revision N
//   every 45 s   send "ping" (answered "pong" without waking the server), so
//                NATs and proxies keep the connection
//   "removed"    the TV was removed or the account reset or deleted: pull
//                to confirm (/v1/sync answers 401), then sign out. Close
//                4401 follows, but the connection itself can take seconds
//                to end (until the server's object goes idle), so act on
//                this message rather than wait for onclose
//   close 4401   the same, if "removed" was missed
//   close 4409   another socket of this TV took over: don't reconnect
//   other closes reconnect after reconnectDelay(attempt), and keep polling;
//                the first "rev N" after reconnecting catches up

export const EVENTS_PATH = "/v1/events";
export const EVENTS_PROTOCOL = "velio-events.1";
const BEARER_PREFIX = "bearer.";

export const PING = "ping";
export const PONG = "pong";
export const PING_EVERY_MS = 45_000;

/** WebSocket close codes the server uses (4000–4999 are the application's). */
export const EVENTS_CLOSE = {
  /** The account no longer names this TV, or was reset. */
  removed: 4401,
  /** A newer socket of the same TV took this one's place. */
  replaced: 4409,
} as const;

/** wss://velio.tv/v1/events from https://velio.tv (ws:// from http://, for the test server). */
export const eventsUrl = (site: string) => site.replace(/\/+$/, "").replace(/^http/i, "ws") + EVENTS_PATH;

/** The subprotocols a TV opens the socket with. */
export const eventsProtocols = (deviceToken: string) => [EVENTS_PROTOCOL, BEARER_PREFIX + deviceToken];

/**
 * The device token from a Sec-WebSocket-Protocol header, if it offers
 * EVENTS_PROTOCOL and a bearer token; undefined otherwise.
 */
export const readEventsProtocols = (header: string | null | undefined) => {
  const offered = (header ?? "").split(",").map(part => part.trim());
  if (offered.indexOf(EVENTS_PROTOCOL) < 0) return undefined;
  for (const part of offered)
    if (part.indexOf(BEARER_PREFIX) === 0 && part.length > BEARER_PREFIX.length)
      return part.slice(BEARER_PREFIX.length);
  return undefined;
};

export type SyncEvent = { type: "rev"; rev: number } | { type: "removed" };

export const revEvent = (rev: number) => `rev ${rev}`;
export const REMOVED_EVENT = "removed";

/** Reads a message from the socket; undefined for anything else, such as "pong". */
export const readEvent = (data: unknown): SyncEvent | undefined => {
  if (typeof data !== "string") return undefined;
  if (data === REMOVED_EVENT) return { type: "removed" };
  const match = /^rev (\d{1,15})$/.exec(data);
  return match ? { type: "rev", rev: Number(match[1]) } : undefined;
};

const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 5 * 60_000;

/**
 * How long to wait before reconnecting, after `attempt` failures in a row
 * (0 for the first): doubling from 1 s up to 5 minutes, and anywhere in the
 * upper half of that, so TVs that lost the server together don't all come
 * back at once.
 */
export const reconnectDelay = (attempt: number, random: () => number = Math.random) => {
  const ceiling = Math.min(LAST_RETRY_MS, FIRST_RETRY_MS * Math.pow(2, Math.max(0, Math.min(attempt, 20))));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
};
