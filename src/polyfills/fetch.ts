// fetch (Chromium 42) for webOS 3 (Chromium 38), over XMLHttpRequest: just
// what the app uses. A response has ok, status, headers.get(), json(),
// text(), arrayBuffer() and a body to read with getReader(), as the
// importer streams downloads (stream.ts). XMLHttpRequest can't hand over a
// download as it arrives, so the body comes whole and the reader gives it
// out in pieces, which lets the gunzip and the parser work piece by piece.
// An abort signal stops the request. Modules that use the global fetch call
// ensureFetch() first; it does nothing where fetch exists.

import { abortError } from "./abort";

const PIECE_BYTES = 64 * 1024;
// Statuses whose responses have no body, as with fetch.
const NO_BODY = new Set([101, 204, 205, 304]);

class SimpleHeaders {
  private values = new Map<string, string>();

  constructor(raw: string) {
    for (const line of raw.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      const before = this.values.get(name);
      this.values.set(name, before === undefined ? value : `${before}, ${value}`);
    }
  }

  get(name: string) {
    return this.values.get(name.toLowerCase()) ?? null;
  }

  has(name: string) {
    return this.values.has(name.toLowerCase());
  }
}

/** A reader over bytes already here, a piece at a time. */
const pieceReader = (bytes: Uint8Array<ArrayBuffer>) => {
  let at = 0;
  return {
    read: () => {
      if (at >= bytes.length) return Promise.resolve({ done: true as const, value: undefined });
      const value = bytes.subarray(at, at + PIECE_BYTES);
      at += value.length;
      return Promise.resolve({ done: false as const, value });
    },
    cancel: () => {
      at = bytes.length;
      return Promise.resolve();
    },
    releaseLock: () => undefined,
  };
};

export class SimpleResponse {
  readonly ok: boolean;
  readonly body: { getReader: () => ReturnType<typeof pieceReader> } | null;
  private used = false;

  constructor(
    private readonly bytes: Uint8Array<ArrayBuffer>,
    readonly status: number,
    readonly statusText: string,
    readonly headers: SimpleHeaders,
    readonly url: string,
  ) {
    this.ok = status >= 200 && status < 300;
    this.body = NO_BODY.has(status) ? null : { getReader: () => pieceReader(this.take()) };
  }

  private take() {
    if (this.used) throw new TypeError("The body has already been read");
    this.used = true;
    return this.bytes;
  }

  arrayBuffer() {
    try {
      const bytes = this.take();
      return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  text() {
    try {
      return Promise.resolve(new TextDecoder().decode(this.take()));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  json(): Promise<unknown> {
    return this.text().then(text => JSON.parse(text));
  }
}

const headerPairs = (headers: HeadersInit | undefined): [string, string][] => {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map(([name, value]) => [name, value]);
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const pairs: [string, string][] = [];
    headers.forEach((value, name) => pairs.push([name, value]));
    return pairs;
  }
  return Object.entries(headers);
};

/** fetch over XMLHttpRequest, for GET and PUT with a text body. */
export const simpleFetch = (input: RequestInfo | URL, init: RequestInit = {}) =>
  new Promise<SimpleResponse>((resolve, reject) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const { signal } = init;
    if (signal?.aborted) {
      reject(abortError("The user aborted a request."));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(init.method ?? "GET", url, true);
    xhr.responseType = "arraybuffer";
    for (const [name, value] of headerPairs(init.headers)) xhr.setRequestHeader(name, value);
    const onAbort = () => {
      xhr.abort();
      reject(abortError("The user aborted a request."));
    };
    signal?.addEventListener("abort", onAbort);
    const done = () => signal?.removeEventListener("abort", onAbort);
    xhr.addEventListener("load", () => {
      done();
      const buffer: unknown = xhr.response;
      const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : new ArrayBuffer(0));
      resolve(
        new SimpleResponse(
          bytes,
          xhr.status,
          xhr.statusText,
          new SimpleHeaders(xhr.getAllResponseHeaders()),
          url,
        ),
      );
    });
    const failed = () => {
      done();
      reject(new TypeError("Failed to fetch"));
    };
    xhr.addEventListener("error", failed);
    xhr.addEventListener("timeout", failed);
    const body = init.body;
    xhr.send(typeof body === "string" ? body : null);
  });

/** Adds fetch where the browser lacks it. */
export const ensureFetch = () => {
  if (typeof fetch === "undefined") Object.assign(self, { fetch: simpleFetch });
};
