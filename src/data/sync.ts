// Velio Sync on the TV (SYNC-PLAN.md, step 2): what the TV keeps from
// signing in, and its pulls. The owner edits their lists and profiles on the
// web, and this TV pulls what its profiles may use: GET /v1/sync with the
// device token, usually answered 304. A new pull is checked and opened in a
// worker (sync.worker.ts), as the signature check alone took 140 ms on the
// test TV, then handed on (onView) to be applied: the lists to the source
// manager, the profiles to the picker.
//
// The TV only reads. A 401, or a manifest that no longer names this TV
// (DeviceRemoved), means the TV is out of the account: it was removed, the
// account was reset, deleted or closed. Then the TV forgets everything it
// had from it (onSignedOut). Any other problem keeps the last view, to show
// on the Account page, and the next pull tries again.
//
// Kept as "velio.sync" in localStorage through appStorage, and written only
// when it changes, so pulls don't grow storage.

import { createRoot, createSignal } from "solid-js";
import { ensureAbortController } from "../polyfills/abort";
import { ensureFetch } from "../polyfills/fetch";
import type { DeviceTrust, DeviceView } from "../sync-core/device";

ensureAbortController();
ensureFetch();

export const DEFAULT_SITE = "https://velio.tv";

/**
 * A server address as typed, made into the form kept: https:// when it has
 * no scheme, no slash at the end, and nothing after a ? or #. A path stays,
 * for a server behind a proxy (https://example.com/velio). Empty means
 * velio.tv; undefined means it isn't an address.
 */
export const cleanSite = (typed: string): string | undefined => {
  let site = typed.trim();
  if (site === "") return DEFAULT_SITE;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(site)) site = `https://${site}`;
  site = site.replace(/\/+$/, "");
  const match = /^(https?):\/\/([^\s/?#@]+)(\/[^\s?#]*)?$/i.exec(site);
  if (!match) return undefined;
  return `${match[1].toLowerCase()}://${match[2].toLowerCase()}${match[3] ?? ""}`;
};
const STORAGE_KEY = "velio.sync";
const TIMEOUT_MS = 20_000;
const SIGN_OUT_TIMEOUT_MS = 8_000;

export interface SyncSaved {
  /** The server: https://velio.tv, or a self-hosted one or a test server. */
  site: string;
  trust?: DeviceTrust;
  token?: string;
  /** The last pull opened. */
  view?: DeviceView;
  /** When that view was opened. */
  pulledAt?: number;
  /** The account signed this TV out; shown once, until seen. */
  signedOutNotice?: true;
}

/** What a pull came to. */
export type PullOutcome =
  | { result: "signedOut" }
  | { result: "same" }
  | { result: "changed"; view: DeviceView }
  | { result: "removed" }
  | { result: "failed"; problem: string; offline?: true };

export interface SyncStatus {
  pulling: boolean;
  /** When the last pull finished, and what it came to (kept in memory only). */
  checkedAt?: number;
  last?: PullOutcome;
}

/** Opens a pull: sync-core's openPull(), in a worker in the app. */
export type PullOpener = (trust: DeviceTrust, pull: unknown, previous?: DeviceView) => Promise<DeviceView>;

export interface SyncOptions {
  storage: Storage;
  open: PullOpener;
  fetch?: typeof fetch;
  now?: () => number;
  /** A new view, after a pull or signing in. `before` is the last one, if any. */
  onView?: (view: DeviceView, before: DeviceView | undefined) => void;
  /** The TV left the account, by the user's choice or the account's; `view` was its last. */
  onSignedOut?: (view: DeviceView | undefined, byAccount: boolean) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

const readTrust = (value: unknown): DeviceTrust | undefined => {
  if (!isRecord(value)) return undefined;
  const { account, device, secretKey, signPublicKey, boxPublicKey } = value;
  return isText(account) &&
    isText(device) &&
    isText(secretKey) &&
    isText(signPublicKey) &&
    isText(boxPublicKey)
    ? { account, device, secretKey, signPublicKey, boxPublicKey }
    : undefined;
};

// The view was opened and checked before it was saved; this only guards
// against a broken save.
const readView = (value: unknown): DeviceView | undefined =>
  isRecord(value) &&
  typeof value.rev === "number" &&
  Array.isArray(value.profiles) &&
  Array.isArray(value.lists) &&
  value.profiles.every(profile => isRecord(profile) && isText(profile.id) && Array.isArray(profile.lists)) &&
  value.lists.every(list => isRecord(list) && isText(list.id))
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      (value as unknown as DeviceView)
    : undefined;

/** Reads what was saved, leaving out what doesn't fit. */
export const readSync = (value: unknown): SyncSaved => {
  const saved: SyncSaved = { site: DEFAULT_SITE };
  if (!isRecord(value)) return saved;
  const site = isText(value.site) ? cleanSite(value.site) : undefined;
  if (site) saved.site = site;
  const trust = readTrust(value.trust);
  if (trust && isText(value.token)) {
    saved.trust = trust;
    saved.token = value.token;
    const view = readView(value.view);
    if (view) saved.view = view;
    if (typeof value.pulledAt === "number") saved.pulledAt = value.pulledAt;
  }
  if (value.signedOutNotice === true) saved.signedOutNotice = true;
  return saved;
};

const load = (storage: Storage) => {
  try {
    return readSync(JSON.parse(storage.getItem(STORAGE_KEY) ?? "null"));
  } catch (error) {
    console.error("Couldn't read the sync settings:", error);
    return readSync(null);
  }
};

/** The answer's {"problem": "..."}, or its status. */
const problemOf = async (response: Response) => {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isText(body.problem)) return body.problem;
  } catch {
    // Not JSON.
  }
  return `HTTP ${response.status}`;
};

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

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createSync = (options: SyncOptions) =>
  createRoot(() => {
    const now = options.now ?? Date.now;
    // Late, so tests and probes can replace the global one.
    const fetcher: typeof fetch = (input, init) => (options.fetch ?? fetch)(input, init);
    const [saved, setSaved] = createSignal(load(options.storage));
    const [status, setStatus] = createSignal<SyncStatus>({ pulling: false });

    const save = (next: SyncSaved) => {
      setSaved(next);
      try {
        options.storage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (error) {
        console.error("Couldn't save the sync settings:", error);
      }
    };

    /** Forgets the sign-in, keeping the site; with `byAccount`, says so once. */
    const forget = (byAccount: boolean) => {
      const before = saved();
      if (!before.token) return;
      const next: SyncSaved = { site: before.site };
      if (byAccount) next.signedOutNotice = true;
      save(next);
      options.onSignedOut?.(before.view, byAccount);
    };

    const pullOnce = async (): Promise<PullOutcome> => {
      const { site, trust, token, view: previous } = saved();
      if (!trust || !token) return { result: "signedOut" };
      // Another sign-in, or a sign-out, while this one waited.
      const stillSignedIn = () => saved().token === token;
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (previous) headers["If-None-Match"] = `"${previous.rev}"`;
      let response: Response;
      try {
        response = await fetchWithin(
          fetcher,
          `${site}/v1/sync`,
          { method: "GET", headers, cache: "no-store" },
          TIMEOUT_MS,
        );
      } catch (error) {
        return { result: "failed", problem: errorText(error), offline: true };
      }
      if (!stillSignedIn()) return { result: "signedOut" };
      if (response.status === 304) return { result: "same" };
      if (response.status === 401) {
        forget(true);
        return { result: "removed" };
      }
      if (!response.ok) return { result: "failed", problem: await problemOf(response) };

      let view: DeviceView;
      try {
        const pull: unknown = await response.json();
        view = await options.open(trust, pull, previous);
      } catch (error) {
        if (!stillSignedIn()) return { result: "signedOut" };
        // Across the worker, an error keeps its name but not its class.
        if (error instanceof Error && error.name === "DeviceRemoved") {
          forget(true);
          return { result: "removed" };
        }
        return { result: "failed", problem: errorText(error) };
      }
      if (!stillSignedIn()) return { result: "signedOut" };
      save({ ...saved(), view, pulledAt: now() });
      // The view is in; a problem showing it isn't the pull's.
      try {
        options.onView?.(view, previous);
      } catch (error) {
        console.error("Velio Sync: couldn't apply the new view:", error);
      }
      return { result: "changed", view };
    };

    // One pull at a time: one asked for while another runs waits for it,
    // then runs once more for everyone who asked meanwhile.
    let running: Promise<PullOutcome> | undefined;
    let next: Promise<PullOutcome> | undefined;
    const runPull = (): Promise<PullOutcome> => {
      setStatus(before => ({ ...before, pulling: true }));
      running = pullOnce()
        .catch((error: unknown): PullOutcome => ({ result: "failed", problem: errorText(error) }))
        .then(outcome => {
          running = undefined;
          setStatus({ pulling: next !== undefined, checkedAt: now(), last: outcome });
          if (outcome.result === "failed") console.warn("Velio Sync: the pull failed:", outcome.problem);
          return outcome;
        });
      return running;
    };
    const pull = (): Promise<PullOutcome> => {
      if (!running) return runPull();
      next ??= running.then(() => {
        next = undefined;
        return runPull();
      });
      return next;
    };

    return {
      /** Everything kept, as saved. */
      saved,
      site: () => saved().site,
      signedIn: () => saved().token !== undefined,
      /** Whether the server answered the last time it was asked: signed in, and the last pull got through. */
      connected: () => {
        const last = status().last?.result;
        return saved().token !== undefined && (last === "same" || last === "changed");
      },
      view: () => saved().view,
      status,
      pull,

      /** Keeps what signing in gave the TV, then pulls at once. */
      signIn: (trust: DeviceTrust, token: string) => {
        save({ site: saved().site, trust, token });
        return pull();
      },

      /**
       * Signs out here: tells the server (so the token stops working), then,
       * whatever it answered, forgets the keys, token and view.
       */
      signOut: async () => {
        const { site, token } = saved();
        if (!token) return;
        try {
          const response = await fetchWithin(
            fetcher,
            `${site}/v1/signout`,
            { method: "POST", headers: { Authorization: `Bearer ${token}` } },
            SIGN_OUT_TIMEOUT_MS,
          );
          if (response.status !== 204) console.warn(`Velio Sync: signing out answered ${response.status}`);
        } catch (error) {
          console.warn("Velio Sync: couldn't reach the server to sign out:", error);
        }
        if (saved().token === token) forget(false);
      },

      /** The account signed the TV out (events said so, and a pull confirmed it). */
      signedOutNotice: () => saved().signedOutNotice === true,
      dismissNotice: () => {
        if (!saved().signedOutNotice) return;
        const { signedOutNotice: _seen, ...rest } = saved();
        save(rest);
      },

      /**
       * Points a signed-out TV at another server: a self-hosted one, or a
       * test one. Takes the address as typed (cleanSite); empty is velio.tv.
       * False when signed in, as the keys belong to the server, or when it
       * isn't an address.
       */
      setSite: (typed: string) => {
        const site = cleanSite(typed);
        if (saved().token || !site) return false;
        if (site !== saved().site) save({ ...saved(), site });
        return true;
      },
    };
  });

export type Sync = ReturnType<typeof createSync>;
