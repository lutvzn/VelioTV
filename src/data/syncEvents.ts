// Live updates from Velio Sync (SYNC-PLAN.md, step 6), as sync-core's
// events.ts says: while the TV is signed in and in view, it keeps a WebSocket
// to /v1/events. "rev N" means pull, unless the TV has N already; "removed"
// or close 4401 means pull, which then answers 401 and signs the TV out.
// Close 4409 means another socket of this TV took over, so this one stays
// closed. Anything else reconnects after reconnectDelay(). The socket only
// says when to pull: the 15-minute pull goes on either way.

import { createSignal } from "solid-js";
import {
  EVENTS_CLOSE,
  eventsProtocols,
  eventsUrl,
  PING,
  PING_EVERY_MS,
  readEvent,
  reconnectDelay,
} from "../sync-core/events";

/** What the events need of a WebSocket, so tests can give a fake one. */
export interface EventsSocket {
  send(data: string): void;
  close(code?: number): void;
  addEventListener<K extends "open" | "message" | "close">(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
  ): void;
}

export type EventsState = "off" | "connecting" | "open" | "waiting" | "replaced";

export interface SyncEventsOptions {
  site: () => string;
  token: () => string | undefined;
  /** The revision the TV has. */
  rev: () => number | undefined;
  pull: () => Promise<unknown>;
  connect?: (url: string, protocols: string[]) => EventsSocket;
  random?: () => number;
}

const openSocket = (url: string, protocols: string[]): EventsSocket => new WebSocket(url, protocols);

export const createSyncEvents = (options: SyncEventsOptions) => {
  const connect = options.connect ?? openSocket;
  const [state, setState] = createSignal<EventsState>("off");
  let socket: EventsSocket | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let wanted = false;

  const pull = () => {
    options.pull().catch((error: unknown) => console.warn("Velio Sync: the pull failed:", error));
  };

  const clearTimers = () => {
    clearInterval(ping);
    clearTimeout(retry);
    ping = undefined;
    retry = undefined;
  };

  const drop = () => {
    const was = socket;
    socket = undefined;
    // Its events are ignored from here on, as it's no longer `socket`.
    if (!was) return;
    try {
      was.close(1000);
    } catch {
      // Closing an unopened socket can throw on old TVs.
    }
  };

  const open = () => {
    clearTimers();
    const token = options.token();
    if (!wanted || !token) {
      setState("off");
      return;
    }
    let opened: EventsSocket;
    try {
      opened = connect(eventsUrl(options.site()), eventsProtocols(token));
    } catch (error) {
      console.warn("Velio Sync: couldn't open the events socket:", error);
      later();
      return;
    }
    socket = opened;
    setState("connecting");
    opened.addEventListener("open", () => {
      if (socket !== opened) return;
      attempt = 0;
      setState("open");
      ping = setInterval(() => {
        try {
          opened.send(PING);
        } catch {
          // onclose follows.
        }
      }, PING_EVERY_MS);
    });
    opened.addEventListener("message", event => {
      if (socket !== opened) return;
      const message = readEvent(event.data);
      if (!message) return;
      if (message.type === "removed") pull();
      else if (message.rev !== options.rev()) pull();
    });
    opened.addEventListener("close", event => {
      if (socket !== opened) return;
      socket = undefined;
      clearTimers();
      if (event.code === EVENTS_CLOSE.replaced) {
        setState("replaced");
        return;
      }
      if (event.code === EVENTS_CLOSE.removed) pull();
      later();
    });
  };

  /** Reconnects after a wait that grows with each failure in a row. */
  const later = () => {
    clearTimers();
    if (!wanted || !options.token()) {
      setState("off");
      return;
    }
    setState("waiting");
    retry = setTimeout(open, reconnectDelay(attempt, options.random));
    attempt += 1;
  };

  return {
    state,
    /** Connects, if signed in and not connected already. */
    start: () => {
      wanted = true;
      if (socket || retry !== undefined) return;
      attempt = 0;
      open();
    },
    /** Closes, such as while the app is hidden or after signing out. */
    stop: () => {
      wanted = false;
      clearTimers();
      drop();
      setState("off");
    },
  };
};

export type SyncEvents = ReturnType<typeof createSyncEvents>;
