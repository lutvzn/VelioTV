// The account on the TV (SYNC-PLAN.md): what the TV keeps from signing in,
// and its pulls, through the server's Nuvio API (src/data/nuvio.ts). The
// owner edits their profiles, lists and add-ons on the web, or in a Nuvio
// app, and the TV reads them:
//
//   sync_pull_profiles()                the profiles, and which have a PIN
//   /rest/v1/addons                     each profile's Stremio add-ons
//   /rest/v1/velio_iptv_lists           Velio's IPTV lists (none on Nuvio's own server)
//
// A pull that reads the same as the last is "same"; anything else is a new
// view, handed on (onView) to be applied: the lists to the source manager,
// the profiles to the picker.
//
// The session's access token lasts an hour; the TV refreshes it before then,
// or after a 401. A refresh token the server refuses means the TV is out of
// the account: it was signed out from the devices page, or everywhere, or
// the account was closed. Then the TV forgets everything it had from it
// (onSignedOut). Any other problem keeps the last view, to show on the
// Account page, and the next pull tries again.
//
// Kept as "velio.sync" in localStorage through appStorage, and written only
// when it changes, so pulls don't grow storage.

import { createRoot, createSignal } from "solid-js";
import {
  DEFAULT_PROFILE_COLOR,
  isProfileColor,
  type DeviceProfile,
  type DeviceView,
  type SyncedList,
} from "./accountView";
import {
  call,
  errorText,
  isRecord,
  isText,
  problemOf,
  randomHex,
  readTokens,
  type Call,
  type Server,
  type Session,
} from "./nuvio";

export { fetchWithin } from "./nuvio";

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
const INSTALLATION_KEY = "velio.installation";
const SIGN_OUT_TIMEOUT_MS = 8_000;
/** A token this close to expiring is refreshed first. */
const REFRESH_EARLY_MS = 60_000;

/** How the TV names itself to register_current_device. */
export const CLIENT_NAME = "Velio TV";
declare const __VERSION__: string | undefined;
const CLIENT_VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

export interface SyncSaved {
  /** The server: https://velio.tv, or a self-hosted one or a test server. */
  site: string;
  /** Where its API is, from signing in. */
  server?: Server;
  session?: Session;
  /** The last pull that changed something. */
  view?: DeviceView;
  /** When that pull was. */
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

/** What a profile's PIN came to. */
export type PinOutcome =
  | { result: "unlocked" }
  | { result: "wrong" }
  /** Too many wrong ones: the server waits this long. */
  | { result: "locked"; seconds: number }
  | { result: "failed"; problem: string };

export interface SyncOptions {
  storage: Storage;
  fetch?: typeof fetch;
  now?: () => number;
  /** The name of the main profile, on an account that has made none yet. */
  mainProfileName?: () => string;
  /** The name the TV registers under, such as "Samsung TV UE55". */
  deviceName?: () => string;
  /** A new view, after a pull or signing in. `before` is the last one, if any. */
  onView?: (view: DeviceView, before: DeviceView | undefined) => void;
  /** The TV left the account, by the user's choice or the account's; `view` was its last. */
  onSignedOut?: (view: DeviceView | undefined, byAccount: boolean) => void;
}

const readServer = (value: unknown): Server | undefined =>
  isRecord(value) && isText(value.site) && isText(value.backend) && isText(value.key)
    ? { site: value.site, backend: value.backend, key: value.key }
    : undefined;

const readSession = (value: unknown): Session | undefined =>
  isRecord(value) && isText(value.access) && isText(value.refresh) && typeof value.expiresAt === "number"
    ? { access: value.access, refresh: value.refresh, expiresAt: value.expiresAt }
    : undefined;

// The view was built before it was saved; this only guards against a broken save.
const readView = (value: unknown): DeviceView | undefined =>
  isRecord(value) &&
  Array.isArray(value.profiles) &&
  Array.isArray(value.lists) &&
  value.profiles.every(
    profile =>
      isRecord(profile) &&
      isText(profile.id) &&
      isProfileColor(profile.color) &&
      Array.isArray(profile.lists),
  ) &&
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
  const server = readServer(value.server);
  const session = readSession(value.session);
  if (server && session) {
    saved.server = server;
    saved.session = session;
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

/** This TV's id for register_current_device, made once and kept. */
const installationId = (storage: Storage) => {
  try {
    const kept = storage.getItem(INSTALLATION_KEY);
    if (kept) return kept;
    const made = `velio-tv-${randomHex(16)}`;
    storage.setItem(INSTALLATION_KEY, made);
    return made;
  } catch {
    return `velio-tv-${randomHex(16)}`;
  }
};

const rowsOf = async (response: Response): Promise<Record<string, unknown>[]> => {
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("The server's answer wasn't understood");
  return body.filter(isRecord);
};

const textOf = (value: unknown) => (isText(value) ? value : undefined);

const listOf = (row: Record<string, unknown>): SyncedList | undefined => {
  if (!isText(row.id) || (row.kind !== "m3u" && row.kind !== "xtream")) return undefined;
  const list: SyncedList = {
    id: row.id,
    name: textOf(row.name) ?? row.id,
    kind: row.kind,
    refreshHours: typeof row.refresh_hours === "number" ? row.refresh_hours : 24,
  };
  for (const key of ["url", "server", "username", "password"] as const) {
    const text = textOf(row[key]);
    if (text !== undefined) list[key] = text;
  }
  if (Array.isArray(row.guide_urls)) {
    const guides = row.guide_urls.filter(isText);
    if (guides.length > 0) list.guideUrls = guides;
  }
  if (row.disabled === true) list.disabled = true;
  return list;
};

/** An add-on's name, from its address when it has none: "addon.example". */
const addonName = (url: string) => /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url;

/** The profiles, add-ons and lists read, as the TV's view. */
export const buildView = (
  profileRows: Record<string, unknown>[],
  addonRows: Record<string, unknown>[],
  listRows: Record<string, unknown>[],
  mainName: string,
): DeviceView => {
  const found = profileRows
    .filter(row => typeof row.profile_index === "number")
    .map(row => ({ row, index: Number(row.profile_index) }))
    // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
    .sort((a, b) => a.index - b.index);
  // An account that has made no profile yet has Nuvio's main one, 1.
  const accountProfiles = found.length > 0 ? found : [{ row: { name: mainName }, index: 1 }];

  const lists: SyncedList[] = [];
  const iptv: { list: SyncedList; profiles: number[] }[] = [];
  for (const row of listRows) {
    const list = listOf(row);
    if (!list) continue;
    const ids = Array.isArray(row.profile_ids) ? row.profile_ids.filter(id => typeof id === "number") : [];
    lists.push(list);
    iptv.push({ list, profiles: ids });
  }
  const addons = addonRows
    .filter(row => isText(row.id) && isText(row.url))
    // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
  for (const row of addons) {
    const url = String(row.url);
    const list: SyncedList = {
      id: String(row.id),
      name: textOf(row.name) ?? addonName(url),
      kind: "stremio",
      url,
      refreshHours: 24,
    };
    if (row.enabled === false) list.disabled = true;
    lists.push(list);
  }

  const profiles = accountProfiles.map(({ row, index }): DeviceProfile => {
    // A profile that uses the main one's add-ons has those.
    const addonsOf = row.uses_primary_addons === true ? 1 : index;
    const profile: DeviceProfile = {
      id: String(index),
      name: textOf(row.name) ?? mainName,
      color: isProfileColor(row.avatar_color_hex) ? row.avatar_color_hex : DEFAULT_PROFILE_COLOR,
      lists: [
        ...iptv
          .filter(entry => entry.profiles.length === 0 || entry.profiles.includes(index))
          .map(entry => entry.list.id),
        ...addons.filter(addon => Number(addon.profile_id ?? 1) === addonsOf).map(addon => String(addon.id)),
      ],
    };
    if (row.pin_enabled === true) profile.locked = true;
    return profile;
  });
  // Only what some profile uses.
  const used = new Set(profiles.flatMap(profile => profile.lists));
  return { profiles, lists: lists.filter(list => used.has(list.id)) };
};

const sameView = (a: DeviceView | undefined, b: DeviceView) =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/** The account signed the TV out: its refresh token is refused. */
const SIGNED_OUT = "signedOut";

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
    /** Counts sign-ins and sign-outs, so a pull that outlived its sign-in keeps nothing. */
    let signIns = 0;
    const forget = (byAccount: boolean) => {
      const before = saved();
      if (!before.session) return;
      signIns++;
      const next: SyncSaved = { site: before.site };
      if (byAccount) next.signedOutNotice = true;
      save(next);
      options.onSignedOut?.(before.view, byAccount);
    };

    // One refresh at a time: the old refresh token works once.
    let refreshing: Promise<Session | typeof SIGNED_OUT> | undefined;
    const refresh = (server: Server, session: Session) => {
      refreshing ??= (async () => {
        try {
          const response = await call(fetcher, server, "/auth/v1/token?grant_type=refresh_token", {
            body: { refresh_token: session.refresh },
          });
          // Another sign-in, or a sign-out, while this one waited.
          if (saved().session?.refresh !== session.refresh) return saved().session ?? SIGNED_OUT;
          if (response.ok) {
            const next = readTokens(await response.json().catch(() => null), now());
            if (!next) throw new Error("The server's answer wasn't understood");
            save({ ...saved(), session: next });
            return next;
          }
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429
          ) {
            forget(true);
            return SIGNED_OUT;
          }
          throw new Error(await problemOf(response));
        } finally {
          refreshing = undefined;
        }
      })();
      return refreshing;
    };

    /**
     * A call as the signed-in user: refreshes the token first if it's about
     * to run out, and once more after a 401. Undefined when signed out.
     */
    const signedInCall = async (path: string, request: Call = {}): Promise<Response | undefined> => {
      const { server, session } = saved();
      if (!server || !session) return undefined;
      let current: Session | typeof SIGNED_OUT = session;
      if (session.expiresAt - now() < REFRESH_EARLY_MS) current = await refresh(server, session);
      if (current === SIGNED_OUT) return undefined;
      const response = await call(fetcher, server, path, { ...request, token: current.access });
      if (response.status !== 401) return response;
      const next = await refresh(server, current);
      if (next === SIGNED_OUT) return undefined;
      return call(fetcher, server, path, { ...request, token: next.access });
    };

    /** Rows from `path`; none when the server hasn't it (a 404: Nuvio's own has no IPTV lists). */
    const read = async (path: string, request?: Call, optional = false) => {
      const response = await signedInCall(path, request);
      if (!response) return undefined;
      if (optional && response.status === 404) return [];
      if (!response.ok) throw new Error(await problemOf(response));
      return rowsOf(response);
    };

    /** Why a pull found the TV signed out: the account signed it out (its refresh was refused), or the user did. */
    const gone = (): PullOutcome =>
      saved().signedOutNotice === true ? { result: "removed" } : { result: "signedOut" };

    const pullOnce = async (): Promise<PullOutcome> => {
      const { session, view: previous } = saved();
      if (!session) return { result: "signedOut" };
      const signedInAs = signIns;
      // Another sign-in, or a sign-out, while this one waited. (A refresh turns the token, not the sign-in.)
      const stillSignedIn = () => saved().session !== undefined && signIns === signedInAs;
      let view: DeviceView;
      try {
        const profiles = await read("/rest/v1/rpc/sync_pull_profiles", { body: {} });
        if (!profiles) return gone();
        const addons = await read(
          "/rest/v1/addons?select=id,url,name,enabled,sort_order,profile_id&order=sort_order.asc",
          {},
          true,
        );
        const lists = await read(
          "/rest/v1/velio_iptv_lists?select=id,name,kind,url,server,username,password,guide_urls,refresh_hours,disabled,profile_ids&order=sort_order.asc,created_at.asc",
          {},
          true,
        );
        if (!addons || !lists) return gone();
        view = buildView(profiles, addons, lists, options.mainProfileName?.() ?? "Main");
      } catch (error) {
        if (!saved().session) return { result: "signedOut" };
        const offline = error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
        return offline
          ? { result: "failed", problem: errorText(error), offline: true }
          : { result: "failed", problem: errorText(error) };
      }
      if (!stillSignedIn()) return { result: "signedOut" };
      // Nothing is written: status().checkedAt says when it was.
      if (sameView(previous, view)) return { result: "same" };
      save({ ...saved(), view, pulledAt: now() });
      // The view is in; a problem showing it isn't the pull's.
      try {
        options.onView?.(view, previous);
      } catch (error) {
        console.error("Account: couldn't apply the new view:", error);
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
          if (outcome.result === "failed") console.warn("Account: the pull failed:", outcome.problem);
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

    /** Lists the TV on the account's devices page, as Nuvio's apps do; a failure only leaves it unnamed. */
    const register = async () => {
      try {
        const response = await signedInCall("/rest/v1/rpc/register_current_device", {
          body: {
            p_installation_id: installationId(options.storage),
            p_client_name: CLIENT_NAME,
            p_client_version: CLIENT_VERSION,
            p_platform: "tv",
            p_device_name: options.deviceName?.() ?? CLIENT_NAME,
          },
        });
        if (response && !response.ok) console.warn("Account: registering the TV:", await problemOf(response));
      } catch (error) {
        console.warn("Account: couldn't register the TV:", error);
      }
    };

    return {
      /** Everything kept, as saved. */
      saved,
      site: () => saved().site,
      signedIn: () => saved().session !== undefined,
      /** Whether the server answered the last time it was asked: signed in, and the last pull got through. */
      connected: () => {
        const last = status().last?.result;
        return saved().session !== undefined && (last === "same" || last === "changed");
      },
      view: () => saved().view,
      status,
      pull,

      /** Keeps the session signing in gave the TV, registers it, then pulls. */
      signIn: async (server: Server, session: Session) => {
        signIns++;
        save({ site: saved().site, server, session });
        await register();
        return pull();
      },

      /** Checks a profile's PIN with the server (verify_profile_pin), which counts wrong ones. */
      checkPin: async (profileId: string, pin: string): Promise<PinOutcome> => {
        try {
          const response = await signedInCall("/rest/v1/rpc/verify_profile_pin", {
            body: { p_profile_id: Number(profileId), p_pin: pin },
          });
          if (!response) return { result: "failed", problem: "Signed out" };
          if (!response.ok) return { result: "failed", problem: await problemOf(response) };
          const row = (await rowsOf(response))[0];
          if (row?.unlocked === true) return { result: "unlocked" };
          const seconds = typeof row?.retry_after_seconds === "number" ? row.retry_after_seconds : 0;
          return seconds > 0 ? { result: "locked", seconds } : { result: "wrong" };
        } catch (error) {
          return { result: "failed", problem: errorText(error) };
        }
      },

      /**
       * Signs out here: tells the server (so the session ends, and its place
       * among the account's TVs is free), then, whatever it answered, forgets
       * the session and view.
       */
      signOut: async () => {
        const { server, session } = saved();
        if (!server || !session) return;
        try {
          const response = await call(fetcher, server, "/auth/v1/logout?scope=local", {
            method: "POST",
            token: session.access,
            timeout: SIGN_OUT_TIMEOUT_MS,
          });
          if (!response.ok) console.warn(`Account: signing out answered ${response.status}`);
        } catch (error) {
          console.warn("Account: couldn't reach the server to sign out:", error);
        }
        if (saved().session) forget(false);
      },

      /** The account signed the TV out (a refresh was refused). */
      signedOutNotice: () => saved().signedOutNotice === true,
      dismissNotice: () => {
        if (!saved().signedOutNotice) return;
        const { signedOutNotice: _seen, ...rest } = saved();
        save(rest);
      },

      /**
       * Points a signed-out TV at another server: a self-hosted one, or a
       * test one. Takes the address as typed (cleanSite); empty is velio.tv.
       * False when signed in, as the session belongs to the server, or when
       * it isn't an address.
       */
      setSite: (typed: string) => {
        const site = cleanSite(typed);
        if (saved().session || !site) return false;
        if (site !== saved().site) save({ ...saved(), site });
        return true;
      },
    };
  });

export type Sync = ReturnType<typeof createSync>;
