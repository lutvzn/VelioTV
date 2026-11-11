// Signing this TV in to a Velio account (SYNC-PLAN.md, step 3; VelioPlatform's
// PLAN.md, "Signing in a TV"). The TV makes a box key pair and two pairing
// secrets, one for a QR code and one to type, and asks the server for a
// pairing (POST /v1/pair). The owner's phone reads the code, gives the TV
// profiles, and answers sealed under the secret. The TV waits for that with
// long polls (GET /v1/pair/:id), opens it, and keeps its keys and the
// device token: the server never sees the secret.

import { toBase64 } from "../sync-core/bytes";
import { newBoxKeyPair, type KeyPair, isSealed } from "../sync-core/crypto";
import type { DeviceTrust } from "../sync-core/device";
import {
  MAX_DEVICE_NAME_LENGTH,
  newPairingSecrets,
  openPairingPayload,
  pairingCode,
  pairingUrl,
  pairRequest,
  type PairingKind,
  type PairingSecrets,
} from "../sync-core/pairing";
import { fetchWithin } from "./sync";

const START_TIMEOUT_MS = 20_000;
/** The server waits up to 20 s for an answer; this allows for the network on top. */
const POLL_TIMEOUT_MS = 35_000;
/** Polls that come back sooner than this wait the rest, to stay under the server's 20 a minute. */
const POLL_AT_LEAST_MS = 3_000;

export interface Pairing {
  site: string;
  id: string;
  pollToken: string;
  /** When the server forgets it, by the server's clock: 10 minutes after it started. */
  expiresAt: number;
  /** When it started, by this TV's clock, as the TV's clock may be wrong. */
  startedAt: number;
  secrets: PairingSecrets;
  keys: KeyPair;
  publicKey: string;
  /** The address the QR code holds, such as https://velio.tv/pair#K7QM.… */
  url: string;
  /** The code to type, such as K7QM-2XHF-9WRT. */
  code: string;
}

export type PairingStep =
  | { status: "waiting" }
  | { status: "done"; trust: DeviceTrust; token: string }
  /** Expired or already used: start again with a new code. */
  | { status: "expired" }
  | { status: "failed"; problem: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

declare const webapis: { productinfo?: { getRealModel?: () => string } } | undefined;
declare const webOS: unknown;

/** What the owner sees on the TVs page: "Samsung TV" and its model, or the like. */
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

const problemOf = async (response: Response) => {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.problem === "string") return body.problem;
  } catch {
    // Not JSON.
  }
  return `HTTP ${response.status}`;
};

/** Asks the server for a pairing; throws an Error with text to show if it can't. */
export const startPairing = async (
  site: string,
  name: string,
  fetcher: typeof fetch,
  now: () => number = Date.now,
): Promise<Pairing> => {
  const keys = newBoxKeyPair();
  const secrets = newPairingSecrets();
  const publicKey = toBase64(keys.publicKey);
  const response = await fetchWithin(
    fetcher,
    `${site}/v1/pair`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pairRequest(secrets, { format: 1, publicKey, name })),
    },
    START_TIMEOUT_MS,
  );
  if (response.status !== 201) throw new Error(await problemOf(response));
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    typeof body.id !== "string" ||
    typeof body.pollToken !== "string" ||
    typeof body.expiresAt !== "number"
  )
    throw new Error("The server's answer wasn't understood");
  return {
    site,
    id: body.id,
    pollToken: body.pollToken,
    expiresAt: body.expiresAt,
    startedAt: now(),
    secrets,
    keys,
    publicKey,
    url: pairingUrl(site, body.id, secrets),
    code: pairingCode(body.id, secrets),
  };
};

/** Opens the phone's answer and keeps what the TV must trust. */
export const finishPairing = (pairing: Pairing, answer: Record<string, unknown>): PairingStep => {
  const { deviceId, deviceToken, kind, payload } = answer;
  if (
    typeof deviceId !== "string" ||
    typeof deviceToken !== "string" ||
    (kind !== "qr" && kind !== "code") ||
    !isSealed(payload)
  )
    return { status: "failed", problem: "The server's answer wasn't understood" };
  try {
    const opened = openPairingPayload(
      kind satisfies PairingKind,
      pairing.secrets,
      payload,
      pairing.publicKey,
    );
    if (opened.device !== deviceId) return { status: "failed", problem: "The sign-in is for another TV" };
    return {
      status: "done",
      token: deviceToken,
      trust: {
        account: opened.account,
        device: opened.device,
        secretKey: toBase64(pairing.keys.secretKey),
        signPublicKey: opened.signPublicKey,
        boxPublicKey: opened.boxPublicKey,
      },
    };
  } catch (error) {
    return { status: "failed", problem: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Waits once for the owner (the server holds the request up to 20 s).
 * A network failure answers "waiting", so the caller simply asks again.
 */
export const pollPairing = async (pairing: Pairing, fetcher: typeof fetch): Promise<PairingStep> => {
  let response: Response;
  try {
    response = await fetchWithin(
      fetcher,
      `${pairing.site}/v1/pair/${pairing.id}`,
      { method: "GET", headers: { Authorization: `Bearer ${pairing.pollToken}` }, cache: "no-store" },
      POLL_TIMEOUT_MS,
    );
  } catch {
    return { status: "waiting" };
  }
  if (response.status === 410 || response.status === 404) return { status: "expired" };
  // Too many polls: wait, as for "waiting".
  if (response.status === 429) return { status: "waiting" };
  if (!response.ok) return { status: "failed", problem: await problemOf(response) };
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) return { status: "failed", problem: "The server's answer wasn't understood" };
  if (body.status === "waiting") return { status: "waiting" };
  if (body.status === "done") return finishPairing(pairing, body);
  return { status: "failed", problem: "The server's answer wasn't understood" };
};

export interface PairingRun {
  /** Stops waiting; the pairing expires on the server by itself. */
  stop: () => void;
  /** Resolves when it ends: signed in, expired, failed, or stopped (undefined). */
  done: Promise<PairingStep | undefined>;
}

/**
 * Polls until the owner answers, the pairing expires, or stop(). After an
 * answer in under 3 s, it waits the rest, so a server that answers at once
 * isn't asked more than 20 times a minute.
 */
export const waitForOwner = (
  pairing: Pairing,
  fetcher: typeof fetch,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): PairingRun => {
  let stopped = false;
  const lifetime = pairing.expiresAt - pairing.startedAt;
  const run = async (): Promise<PairingStep | undefined> => {
    for (;;) {
      if (stopped) return undefined;
      // By this TV's clock: the server's 10 minutes from when it started.
      if (lifetime > 0 && now() - pairing.startedAt >= lifetime) return { status: "expired" };
      const asked = now();
      const step = await pollPairing(pairing, fetcher);
      if (stopped) return undefined;
      if (step.status !== "waiting") return step;
      const took = now() - asked;
      if (took < POLL_AT_LEAST_MS) await wait(POLL_AT_LEAST_MS - took);
    }
  };
  return {
    stop: () => {
      stopped = true;
    },
    done: run(),
  };
};
