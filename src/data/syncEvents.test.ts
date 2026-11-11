import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS_CLOSE, PING, PING_EVERY_MS } from "../sync-core/events";
import { createSyncEvents, type EventsSocket } from "./syncEvents";

type Listener = (event: Event) => void;

class FakeSocket implements EventsSocket {
  sent: string[] = [];
  closedWith?: number;
  private listeners: Record<string, Listener[]> = {};
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  addEventListener<K extends "open" | "message" | "close">(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
  ) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    (this.listeners[type] ??= []).push(listener as Listener);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code;
  }
  private fire(event: Event) {
    for (const listener of this.listeners[event.type] ?? []) listener(event);
  }
  open() {
    this.fire(new Event("open"));
  }
  say(data: string) {
    this.fire(new MessageEvent("message", { data }));
  }
  end(code: number) {
    this.fire(new CloseEvent("close", { code }));
  }
}

const setup = (rev = 3) => {
  const sockets: FakeSocket[] = [];
  let token: string | undefined = "device-token";
  const pull = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const events = createSyncEvents({
    site: () => "https://sync.test",
    token: () => token,
    rev: () => rev,
    pull,
    random: () => 1,
    connect: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
  });
  return {
    events,
    sockets,
    pull,
    last: () => sockets[sockets.length - 1],
    signOut: () => {
      token = undefined;
    },
  };
};

describe("live updates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects with the token as a subprotocol and pulls on a new rev only", () => {
    const { events, last, pull } = setup(3);
    events.start();
    expect(last().url).toBe("wss://sync.test/v1/events");
    expect(last().protocols).toEqual(["velio-events.1", "bearer.device-token"]);
    last().open();
    expect(events.state()).toBe("open");
    last().say("rev 3");
    expect(pull).not.toHaveBeenCalled();
    last().say("rev 4");
    last().say("pong");
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("pings every 45 s", () => {
    const { events, last } = setup();
    events.start();
    last().open();
    vi.advanceTimersByTime(PING_EVERY_MS * 2);
    expect(last().sent).toEqual([PING, PING]);
  });

  it("pulls at once on removed, and again on close 4401", () => {
    const { events, last, pull, signOut, sockets } = setup();
    events.start();
    last().open();
    last().say("removed");
    expect(pull).toHaveBeenCalledTimes(1);
    // The pull signed the TV out, so it doesn't reconnect.
    signOut();
    last().end(EVENTS_CLOSE.removed);
    expect(pull).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets.length).toBe(1);
    expect(events.state()).toBe("off");
  });

  it("stays closed when another socket of this TV took over", () => {
    const { events, last, sockets } = setup();
    events.start();
    last().open();
    last().end(EVENTS_CLOSE.replaced);
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets.length).toBe(1);
    expect(events.state()).toBe("replaced");
  });

  it("reconnects after a growing wait, starting again once open", () => {
    const { events, last, sockets } = setup();
    events.start();
    last().end(1006);
    expect(events.state()).toBe("waiting");
    vi.advanceTimersByTime(999);
    expect(sockets.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(2);
    last().end(1006);
    vi.advanceTimersByTime(1999);
    expect(sockets.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(3);
    last().open();
    last().end(1006);
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(4);
  });

  it("closes when stopped, and doesn't reconnect", () => {
    const { events, last, sockets } = setup();
    events.start();
    last().open();
    events.start();
    expect(sockets.length).toBe(1);
    events.stop();
    expect(last().closedWith).toBe(1000);
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets.length).toBe(1);
    expect(events.state()).toBe("off");
  });

  it("does nothing while signed out", () => {
    const { events, sockets, signOut } = setup();
    signOut();
    events.start();
    expect(sockets.length).toBe(0);
  });
});
