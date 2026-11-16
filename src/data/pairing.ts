// Signing this TV in to an account, as Nuvio's TV app does (VelioPlatform's
// PLAN.md, "Nuvio compatibility"). The TV asks for a sign-in code
// (start_device_login_session), and shows it as a QR code, which opens the
// site's /link page with the code, and as a six-character code to type
// there. Whoever approves it there signs the TV in to their account. The
// TV polls (poll_tv_login_session) until then, and exchanges the code for a
// session of its own (tv-logins-exchange); only this TV knows the nonce the
// code was asked for with, so a code seen over a shoulder signs nothing in.
//
// A server without the typed code (an older Nuvio one) still has the QR
// sign-in: start_tv_login_session, approved at /tv-login.

import { MAX_DEVICE_NAME_LENGTH } from "./accountView";
import {
  call,
  discover,
  errorText,
  isMissingFunction,
  isRecord,
  isText,
  problemOf,
  randomHex,
  readTokens,
  type Server,
  type Session,
} from "./nuvio";

/** How long a code lasts when the server doesn't say: Nuvio's 5 minutes. */
const DEFAULT_LIFETIME_MS = 5 * 60_000;
/** The least time between polls, whatever the server asks for. */
const POLL_AT_LEAST_MS = 3_000;

export interface Pairing {
  server: Server;
  /** The code the TV polls and exchanges. */
  code: string;
  /** Known only to this TV: the exchange needs it. */
  nonce: string;
  /** The address the QR code holds, such as https://velio.tv/link?code=K7QM2X. */
  url: string;
  /** The code to type, such as K7QM2X; none on a server without it. */
  userCode?: string;
  /** Where to type it, such as https://velio.tv/link. */
  page?: string;
  /** When it started, and how long it lasts, by this TV's clock (the TV's clock may be wrong). */
  startedAt: number;
  lifetime: number;
  pollMs: number;
}

export type PairingStep =
  | { status: "waiting" }
  | { status: "done"; server: Server; session: Session }
  /** Expired or already used: start again with a new code. */
  | { status: "expired" }
  | { status: "failed"; problem: string };

declare const webapis: { productinfo?: { getRealModel?: () => string } } | undefined;
declare const webOS: unknown;

/** What the owner sees on the devices page: "Samsung TV" and its model, or the like. */
export const tvName = () => {
  let name = "Velio TV";
  if (typeof webapis !== "undefined") {
    name = "Samsung TV";
    try {
      // Needs the productinfo privilege; without it, it throws.
      const model = webapis?.productinfo?.getRealModel?.();
      if (model) name = `Samsung TV ${model}`;
    } catch {
      // The name is only a label.
    }
  } else if (typeof webOS !== "undefined") name = "LG TV";
  return name.slice(0, MAX_DEVICE_NAME_LENGTH);
};

/**
 * A timestamptz as PostgREST or Postgres writes it, read by an old TV's
 * Date.parse too: it takes 3 decimals at most, and an offset with minutes.
 */
export const readTime = (value: unknown) =>
  typeof value === "string"
    ? Date.parse(
        value
          .replace(" ", "T")
          .replace(/(\.\d{3})\d+/, "$1")
          .replace(/([+-]\d{2})$/, "$1:00"),
      )
    : Number.NaN;

/** How long the code lasts, from its expiry and the server's clock (its Date header). */
const lifetimeOf = (expiresAt: unknown, response: Response) => {
  const lifetime = readTime(expiresAt) - Date.parse(response.headers.get("Date") ?? "");
  return lifetime > 0 && lifetime < 60 * 60_000 ? lifetime : DEFAULT_LIFETIME_MS;
};

const pollMsOf = (seconds: unknown) =>
  typeof seconds === "number" && seconds > 0 ? Math.max(POLL_AT_LEAST_MS, seconds * 1000) : 5_000;

const firstRow = async (response: Response): Promise<Record<string, unknown> | undefined> => {
  const body: unknown = await response.json().catch(() => null);
  const row: unknown = Array.isArray(body) ? body[0] : body;
  return isRecord(row) ? row : undefined;
};

const NOT_UNDERSTOOD = "The server's answer wasn't understood";

/** Asks the server for a code; throws an Error with text to show if it can't. */
export const startPairing = async (
  site: string,
  name: string,
  fetcher: typeof fetch,
  now: () => number = Date.now,
): Promise<Pairing> => {
  const server = await discover(site, fetcher);
  const nonce = randomHex(16);
  const started = await call(fetcher, server, "/rest/v1/rpc/start_device_login_session", {
    body: {
      p_device_nonce: nonce,
      p_redirect_base_url: `${site}/link`,
      p_device_name: name,
      p_device_type: "tv",
    },
  });
  if (started.ok) {
    const row = await firstRow(started);
    if (!row || !isText(row.device_code) || !isText(row.verification_uri_complete))
      throw new Error(NOT_UNDERSTOOD);
    return {
      server,
      code: row.device_code,
      nonce,
      url: row.verification_uri_complete,
      userCode: isText(row.user_code) ? row.user_code : undefined,
      page: isText(row.verification_uri) ? row.verification_uri : undefined,
      startedAt: now(),
      lifetime: lifetimeOf(row.expires_at, started),
      pollMs: pollMsOf(row.poll_interval_seconds),
    };
  }
  if (!(await isMissingFunction(started))) throw new Error(await problemOf(started));

  // Only the QR code.
  const qr = await call(fetcher, server, "/rest/v1/rpc/start_tv_login_session", {
    body: { p_device_nonce: nonce, p_redirect_base_url: `${site}/tv-login`, p_device_name: name },
  });
  if (!qr.ok) throw new Error(await problemOf(qr));
  const row = await firstRow(qr);
  if (!row || !isText(row.code) || !isText(row.web_url)) throw new Error(NOT_UNDERSTOOD);
  return {
    server,
    code: row.code,
    nonce,
    url: row.web_url,
    startedAt: now(),
    lifetime: lifetimeOf(row.expires_at, qr),
    pollMs: pollMsOf(row.poll_interval_seconds),
  };
};

/** Trades the approved code for this TV's own session. */
export const exchangePairing = async (
  pairing: Pairing,
  fetcher: typeof fetch,
  now: () => number = Date.now,
): Promise<PairingStep> => {
  let response: Response;
  try {
    response = await call(fetcher, pairing.server, "/functions/v1/tv-logins-exchange", {
      body: { code: pairing.code, device_nonce: pairing.nonce },
    });
  } catch (error) {
    return { status: "failed", problem: errorText(error) };
  }
  // Refused: past the account's TV limit, or the like.
  if (!response.ok) return { status: "failed", problem: await problemOf(response) };
  const session = readTokens(await response.json().catch(() => null), now());
  if (!session) return { status: "failed", problem: NOT_UNDERSTOOD };
  return { status: "done", server: pairing.server, session };
};

/**
 * Asks once whether the code was approved, and if so exchanges it. A
 * network failure answers "waiting", so the caller simply asks again.
 */
export const pollPairing = async (
  pairing: Pairing,
  fetcher: typeof fetch,
  now: () => number = Date.now,
): Promise<PairingStep> => {
  let response: Response;
  try {
    response = await call(fetcher, pairing.server, "/rest/v1/rpc/poll_tv_login_session", {
      body: { p_code: pairing.code, p_device_nonce: pairing.nonce },
    });
  } catch {
    return { status: "waiting" };
  }
  if (response.status === 429 || response.status >= 500) return { status: "waiting" };
  // "Invalid TV login session": it's gone.
  if (!response.ok) return { status: "expired" };
  const status = (await firstRow(response))?.status;
  if (status === "pending") return { status: "waiting" };
  if (status === "approved") return exchangePairing(pairing, fetcher, now);
  if (status === "expired" || status === "exchanged") return { status: "expired" };
  return { status: "failed", problem: NOT_UNDERSTOOD };
};

export interface PairingRun {
  /** Stops waiting; the code expires on the server by itself. */
  stop: () => void;
  /** Resolves when it ends: signed in, expired, failed, or stopped (undefined). */
  done: Promise<PairingStep | undefined>;
}

/** Polls, as often as the server asks, until the code is approved, expires, or stop(). */
export const waitForOwner = (
  pairing: Pairing,
  fetcher: typeof fetch,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): PairingRun => {
  let stopped = false;
  const run = async (): Promise<PairingStep | undefined> => {
    for (;;) {
      await wait(pairing.pollMs);
      if (stopped) return undefined;
      if (now() - pairing.startedAt >= pairing.lifetime) return { status: "expired" };
      const step = await pollPairing(pairing, fetcher, now);
      if (stopped) return undefined;
      if (step.status !== "waiting") return step;
    }
  };
  return {
    stop: () => {
      stopped = true;
    },
    done: run(),
  };
};
