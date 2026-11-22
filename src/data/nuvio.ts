// The server's API, as Nuvio's apps call it (VelioPlatform's PLAN.md, "Nuvio
// compatibility"): velio.tv, a self-hosted Velio server, or Nuvio's own.
//
//   {site}/.well-known/nuvio   where the API is (backend_url) and its key
//   /auth/v1                   sessions: refreshing, signing out
//   /rest/v1                   the account's data: tables, and functions under rpc/
//   /functions/v1              tv-logins-exchange, which signs a TV in
//
// Every call sends the key as `apikey`, and the user's access token, or the
// key again before signing in, as `Authorization: Bearer`.

import { ensureAbortController } from "../polyfills/abort";
import { ensureFetch } from "../polyfills/fetch";

ensureAbortController();
ensureFetch();

/** Where the API is, from the site's discovery document. */
export interface Server {
  /** The address the TV was pointed at, such as https://velio.tv. */
  site: string;
  /** Where /auth/v1, /rest/v1 and /functions/v1 are: the site itself for Velio. */
  backend: string;
  /** The publishable key, sent as `apikey`. */
  key: string;
}

/** What signing in gives the TV, and refreshing turns. */
export interface Session {
  access: string;
  refresh: string;
  /** When the access token stops working, by this TV's clock. */
  expiresAt: number;
}

const DISCOVERY_TIMEOUT_MS = 15_000;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** fetch with a time limit; a network failure or the limit throws. */
export const fetchWithin = async (fetcher: typeof fetch, url: string, init: RequestInit, ms: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The problem an answer gives: GoTrue's msg or error_description,
 * PostgREST's message, a function's error, Velio's problem; else its status.
 */
export const problemOf = async (response: Response) => {
  try {
    const body: unknown = await response.json();
    if (isRecord(body))
      for (const key of ["msg", "error_description", "message", "error", "problem"])
        if (isText(body[key])) return body[key];
  } catch {
    // Not JSON.
  }
  return `HTTP ${response.status}`;
};

/** A thrown problem from the server, with its HTTP status. */
export class ServerProblem extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ServerProblem";
    this.status = status;
  }
}

/** Nuvio's own site: the default, and where its sign-in page is (/tv-login). */
export const NUVIO_SITE = "https://nuvio.tv";

declare const __NUVIO_BACKEND__: string | undefined;
declare const __NUVIO_KEY__: string | undefined;

/**
 * Nuvio's own server, which has no discovery document, so the build carries
 * where it is (NUVIO_BACKEND_URL and NUVIO_PUBLISHABLE_KEY, vite.config.js);
 * undefined in a build without them.
 */
export const builtInNuvio = (): Server | undefined => {
  const backend = typeof __NUVIO_BACKEND__ === "string" ? __NUVIO_BACKEND__.replace(/\/+$/, "") : "";
  const key = typeof __NUVIO_KEY__ === "string" ? __NUVIO_KEY__ : "";
  return backend && key ? { site: NUVIO_SITE, backend, key } : undefined;
};

/**
 * Where the site's API is: Nuvio's own from the build, any other site's from
 * its discovery document. Throws an Error with text to show if there's none.
 */
export const discover = async (
  site: string,
  fetcher: typeof fetch,
  nuvio: Server | undefined = builtInNuvio(),
): Promise<Server> => {
  if (site === NUVIO_SITE) {
    if (!nuvio) throw new Error("This build doesn't have Nuvio's server address");
    return nuvio;
  }
  const response = await fetchWithin(
    fetcher,
    `${site}/.well-known/nuvio`,
    { method: "GET", cache: "no-store" },
    DISCOVERY_TIMEOUT_MS,
  );
  if (!response.ok) throw new ServerProblem(`${site} isn't a Velio or Nuvio server`, response.status);
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || !isText(body.publishable_key))
    throw new ServerProblem(`${site} isn't a Velio or Nuvio server`, response.status);
  const backend = isText(body.backend_url) ? body.backend_url.replace(/\/+$/, "") : site;
  return { site, backend, key: body.publishable_key };
};

/** The session in a token answer (GoTrue's, or tv-logins-exchange's), or undefined. */
export const readTokens = (body: unknown, now: number): Session | undefined => {
  if (!isRecord(body) || !isText(body.access_token) || !isText(body.refresh_token)) return undefined;
  const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return { access: body.access_token, refresh: body.refresh_token, expiresAt: now + seconds * 1000 };
};

export interface Call {
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
  /** The access token; the key without one. */
  token?: string;
  timeout?: number;
}

/** One call to the API at `path`, such as "/rest/v1/rpc/sync_pull_profiles". */
export const call = (fetcher: typeof fetch, server: Server, path: string, request: Call = {}) => {
  const headers: Record<string, string> = {
    apikey: server.key,
    Authorization: `Bearer ${request.token ?? server.key}`,
  };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  return fetchWithin(
    fetcher,
    `${server.backend}${path}`,
    {
      method: request.method ?? (request.body === undefined ? "GET" : "POST"),
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      cache: "no-store",
    },
    request.timeout ?? 20_000,
  );
};

/** PostgREST's answer when a function isn't there: an older server, or Nuvio's own without Velio's. */
export const isMissingFunction = async (response: Response) => {
  if (response.status !== 404) return false;
  try {
    const body: unknown = await response.clone().json();
    return isRecord(body) && body.code === "PGRST202";
  } catch {
    return false;
  }
};

/** A random hex string of `bytes` bytes, from the TV's random source when it has one. */
export const randomHex = (bytes: number) => {
  const values = new Uint8Array(bytes);
  const source: Crypto | undefined = typeof crypto === "undefined" ? undefined : crypto;
  if (source && typeof source.getRandomValues === "function") source.getRandomValues(values);
  else for (let at = 0; at < bytes; at++) values[at] = Math.floor(Math.random() * 256);
  let hex = "";
  for (let at = 0; at < bytes; at++) hex += (values[at] + 0x100).toString(16).slice(1);
  return hex;
};
