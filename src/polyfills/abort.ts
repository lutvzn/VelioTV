// AbortController (Chromium 66) for the oldest TVs supported, webOS 3
// (Chromium 38) and Tizen 3 (47): just enough for the app, which uses a
// signal's `aborted`, its abort event, and passes it to fetch (on webOS 3,
// fetch.ts listens for it; Tizen 3's fetch ignores it). Modules that make
// one call ensureAbortController() first; it does nothing where it exists.
// Also: an AbortError where DOMException can't be made (before Chromium 46).

type Listener = (event: Event) => void;

// Chromium 38's workers can't make an Event; listeners only get its type there.
const abortEvent = (): Event => {
  if (typeof Event === "function") return new Event("abort");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what listeners read of it
  return { type: "abort" } as Event;
};

class SimpleSignal {
  aborted = false;
  reason: unknown = undefined;
  onabort: Listener | null = null;
  private listeners: Listener[] = [];

  addEventListener(type: string, listener: Listener) {
    if (type === "abort" && !this.listeners.includes(listener)) this.listeners.push(listener);
  }

  removeEventListener(type: string, listener: Listener) {
    if (type === "abort") this.listeners = this.listeners.filter(other => other !== listener);
  }

  throwIfAborted() {
    if (this.aborted) throw this.reason;
  }

  /** Called by SimpleController only. */
  abortWith(reason: unknown) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    const event = abortEvent();
    this.onabort?.(event);
    for (const listener of this.listeners.slice()) listener(event);
  }
}

export class SimpleController {
  readonly signal = new SimpleSignal();

  abort(reason?: unknown) {
    this.signal.abortWith(reason ?? abortError("signal is aborted without reason"));
  }
}

/** An error named "AbortError": a DOMException where one can be made. */
export const abortError = (message: string): Error => {
  try {
    return new DOMException(message, "AbortError");
  } catch {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }
};

// By name, as a DOMException isn't an Error in every browser.
export const isAbortError = (error: unknown) =>
  typeof error === "object" && error !== null && Reflect.get(error, "name") === "AbortError";

/** Adds AbortController where the browser lacks it. */
export const ensureAbortController = () => {
  if (typeof AbortController === "undefined") {
    Object.assign(self, { AbortController: SimpleController, AbortSignal: SimpleSignal });
  }
};
