// A made-up account on a fake Nuvio server, for VelioTV's tests and the
// test server (syncServer.mjs): the parts of Nuvio's API, as VelioPlatform's
// server answers them, that a TV uses. Nothing is kept: a new fake is a new
// account. It imports nothing, so Node runs it as it is (its types strip).
//
// The TV's side, as on velio.tv:
//   GET  /.well-known/nuvio
//   POST /rest/v1/rpc/start_device_login_session, start_tv_login_session,
//        poll_tv_login_session, register_current_device,
//        sync_pull_profiles, verify_profile_pin
//   GET  /rest/v1/addons, /rest/v1/velio_iptv_lists
//   POST /functions/v1/tv-logins-exchange
//   POST /auth/v1/token?grant_type=refresh_token, /auth/v1/logout
//
// What the owner does on the web there is methods here: approve() a TV's
// code, addList(), changeList(), removeList(), setPin(), renameProfile(),
// removeDevice() (signing the TVs out on the devices page), close() the
// account.
//
// The account starts with three profiles ("Living room", "Kids", "Guest")
// and lists from `base`, the test server: "Test channels" (50 channels, for
// Living room and Kids), "Kids channels" (Kids), "Test Xtream" (the small
// login, Living room) and "Guest channels" (Guest).

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, Authorization, Content-Type, Prefer, X-Client-Info",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

export const PUBLISHABLE_KEY = "sb_publishable_velio-test";

export interface ListDraft {
  name: string;
  kind: "m3u" | "xtream" | "stremio";
  url?: string;
  server?: string;
  username?: string;
  password?: string;
  guideUrls?: string[];
  refreshHours?: number;
  disabled?: boolean;
}

export const testList = (base: string, name: string, channels = 50): ListDraft => ({
  name,
  kind: "m3u",
  url: `${base}/playlist.m3u?channels=${channels}&days=2&list=${encodeURIComponent(name)}`,
  refreshHours: 24,
});

/** The test server's made-up Stremio add-on (stremio.mjs), or another at `path` (debrid.mjs), as a list. */
export const testAddon = (base: string, name: string, path = "/stremio/manifest.json"): ListDraft => ({
  name,
  kind: "stremio",
  url: `${base}${path}`,
  refreshHours: 24,
});

interface Profile {
  index: number;
  name: string;
  color: string;
  usesPrimaryAddons: boolean;
  pin?: string;
  failed: number;
  lockedUntil?: number;
  updatedAt: number;
}

interface IptvList {
  id: string;
  name: string;
  kind: "m3u" | "xtream";
  url?: string;
  server?: string;
  username?: string;
  password?: string;
  guideUrls: string[];
  refreshHours: number;
  disabled: boolean;
  profiles: number[];
  order: number;
}

interface Addon {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  profile: number;
  order: number;
}

interface Login {
  code: string;
  nonce: string;
  userCode?: string;
  name: string;
  status: "pending" | "approved" | "exchanged" | "expired";
  expiresAt: number;
  polls: number;
}

interface Session {
  id: string;
  refresh: string;
  tv: boolean;
  ended: boolean;
}

export interface NuvioFakeOptions {
  /** Where the test lists are: the test server. */
  base: string;
  /** Where the API answers: `base` by default. */
  site?: string;
  now?: () => number;
  /** How long an access token lasts; an hour, as GoTrue's. */
  accessSeconds?: number;
  /** As an older Nuvio server: no typed codes (start_device_login_session). */
  qrOnly?: boolean;
  /** As Nuvio's own server: no velio_iptv_lists. */
  noIptvLists?: boolean;
  /** The account's TV limit: 10, as velio.tv's. */
  tvLimit?: number;
}

const USER_CODE_LETTERS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LOGIN_MS = 5 * 60_000;
const PIN_TRIES = 5;
const PIN_LOCK_MS = 300_000;

const randomText = (letters: string, length: number) => {
  const values = crypto.getRandomValues(new Uint8Array(length));
  let text = "";
  for (const value of values) text += letters[value % letters.length];
  return text;
};
const hex = (bytes: number) => randomText("0123456789abcdef", bytes * 2);

const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", Date: new Date().toUTCString(), ...CORS, ...headers },
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const textOf = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

/** PostgREST's errors, as { message, code }. */
const rest = (status: number, message: string, code: string) => json(status, { message, code });

const isoOf = (time: number) => new Date(time).toISOString().replace("Z", "+00:00");

export const createNuvioFake = (options: NuvioFakeOptions) => {
  const now = options.now ?? Date.now;
  const site = options.site ?? options.base;
  const accessMs = (options.accessSeconds ?? 3600) * 1000;
  const tvLimit = options.tvLimit ?? 10;
  const userId = crypto.randomUUID();
  let closed = false;
  let nextOrder = 0;
  let nextId = 0;

  const profiles: Profile[] = [];
  const lists: IptvList[] = [];
  const addons: Addon[] = [];
  const logins = new Map<string, Login>();
  const sessions = new Map<string, Session>();
  /** Access tokens: token → its session and when it stops working. */
  const access = new Map<string, { session: string; expiresAt: number }>();
  const devices = new Map<string, Record<string, unknown>>();
  /** Every call, as "POST /rest/v1/rpc/…", for tests. */
  const calls: string[] = [];

  const profileNamed = (name: string) => {
    const found = profiles.find(profile => profile.name === name);
    if (!found) throw new Error(`No profile ${name}`);
    return found;
  };
  const indexesOf = (names: readonly string[]) => names.map(name => profileNamed(name).index);

  const addProfile = (name: string, color: string) => {
    profiles.push({
      index: profiles.length + 1,
      name,
      color,
      usesPrimaryAddons: false,
      failed: 0,
      updatedAt: now(),
    });
  };

  /** Adds a list, or an add-on (one for each profile, as Nuvio keeps them); its id. */
  const addList = (draft: ListDraft, profileNames: readonly string[] = []) => {
    const id = `list-${++nextId}`;
    if (draft.kind === "stremio") {
      const indexes = profileNames.length > 0 ? indexesOf(profileNames) : [1];
      for (const index of indexes)
        addons.push({
          id: indexes.length === 1 ? id : `${id}-${index}`,
          name: draft.name,
          url: draft.url ?? "",
          enabled: !draft.disabled,
          profile: index,
          order: nextOrder++,
        });
      return id;
    }
    lists.push({
      id,
      name: draft.name,
      kind: draft.kind,
      url: draft.url,
      server: draft.server,
      username: draft.username,
      password: draft.password,
      guideUrls: draft.guideUrls ?? [],
      refreshHours: draft.refreshHours ?? 24,
      disabled: draft.disabled ?? false,
      profiles: indexesOf(profileNames),
      order: nextOrder++,
    });
    return id;
  };

  const findList = (idOrName: string) => lists.find(list => list.id === idOrName || list.name === idOrName);
  const findAddons = (idOrName: string) =>
    addons.filter(
      addon => addon.id === idOrName || addon.id.startsWith(`${idOrName}-`) || addon.name === idOrName,
    );

  // The starting account.
  addProfile("Living room", "#E53935");
  addProfile("Kids", "#43A047");
  addProfile("Guest", "#8E24AA");
  addList(testList(options.base, "Test channels"), ["Living room", "Kids"]);
  addList(testList(options.base, "Kids channels", 20), ["Kids"]);
  addList(
    { name: "Test Xtream", kind: "xtream", server: options.base, username: "small", password: "small" },
    ["Living room"],
  );
  addList(testList(options.base, "Guest channels", 10), ["Guest"]);

  const newTokens = (session: Session) => {
    const token = `access-${hex(24)}`;
    access.set(token, { session: session.id, expiresAt: now() + accessMs });
    return {
      access_token: token,
      token_type: "bearer",
      expires_in: Math.round(accessMs / 1000),
      refresh_token: session.refresh,
    };
  };

  /** The session a request's access token stands on: undefined for the key, a 401 for a token that doesn't work. */
  const caller = (request: Request): Session | Response | undefined => {
    const token = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (!token || token === PUBLISHABLE_KEY) return undefined;
    const known = access.get(token);
    const session = known ? sessions.get(known.session) : undefined;
    if (!known || !session || session.ended || closed) return rest(401, "JWT is invalid", "PGRST301");
    if (known.expiresAt <= now()) return rest(401, "JWT expired", "PGRST303");
    return session;
  };

  const tvsSignedIn = () => [...sessions.values()].filter(session => session.tv && !session.ended).length;

  const startLogin = (body: Record<string, unknown>, typed: boolean) => {
    const nonce = textOf(body.p_device_nonce);
    if (nonce.length < 12) return rest(400, "Invalid device nonce", "P0001");
    const code = typed ? hex(24) : hex(16);
    const login: Login = {
      code,
      nonce,
      name: textOf(body.p_device_name, "TV"),
      status: "pending",
      expiresAt: now() + LOGIN_MS,
      polls: 0,
    };
    if (typed) {
      let userCode = randomText(USER_CODE_LETTERS, 6);
      while ([...logins.values()].some(other => other.userCode === userCode))
        userCode = randomText(USER_CODE_LETTERS, 6);
      login.userCode = userCode;
    }
    logins.set(code, login);
    if (typed)
      return json(200, [
        {
          device_code: code,
          user_code: login.userCode,
          verification_uri: `${site}/link`,
          verification_uri_complete: `${site}/link?code=${login.userCode}`,
          expires_at: isoOf(login.expiresAt),
          poll_interval_seconds: 3,
        },
      ]);
    return json(200, [
      {
        code,
        web_url: `${site}/tv-login?code=${code}`,
        expires_at: isoOf(login.expiresAt),
        poll_interval_seconds: 3,
      },
    ]);
  };

  const pollLogin = (body: Record<string, unknown>) => {
    const login = logins.get(textOf(body.p_code));
    if (!login || login.nonce !== body.p_device_nonce) return rest(400, "Invalid TV login session", "P0001");
    login.polls++;
    if (login.status === "pending" && (login.expiresAt <= now() || login.polls > 240))
      login.status = "expired";
    return json(200, [{ status: login.status, expires_at: isoOf(login.expiresAt) }]);
  };

  const exchange = (body: Record<string, unknown>) => {
    const login = logins.get(textOf(body.code));
    if (!login || login.nonce !== body.device_nonce || login.status !== "approved")
      return json(400, { error: "This sign-in code doesn't work" });
    if (tvsSignedIn() >= tvLimit)
      return json(403, { error: `This account is signed in on ${tvLimit} TVs, its limit` });
    login.status = "exchanged";
    const session: Session = {
      id: crypto.randomUUID(),
      refresh: `refresh-${hex(16)}`,
      tv: true,
      ended: false,
    };
    sessions.set(session.id, session);
    return json(200, newTokens(session));
  };

  const refresh = (body: Record<string, unknown>) => {
    const session = [...sessions.values()].find(one => one.refresh === body.refresh_token);
    if (!session || session.ended || closed)
      return json(400, {
        code: 400,
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token: Refresh Token Not Found",
      });
    session.refresh = `refresh-${hex(16)}`;
    return json(200, newTokens(session));
  };

  const pullProfiles = () =>
    json(
      200,
      profiles.map(profile => ({
        id: `${userId.slice(0, 30)}${String(profile.index).padStart(6, "0")}`,
        user_id: userId,
        profile_index: profile.index,
        name: profile.name,
        avatar_color_hex: profile.color,
        uses_primary_addons: profile.usesPrimaryAddons,
        uses_primary_plugins: false,
        avatar_id: null,
        avatar_url: null,
        pin_enabled: profile.pin !== undefined,
        pin_locked_until: profile.lockedUntil === undefined ? null : isoOf(profile.lockedUntil),
        created_at: isoOf(0),
        updated_at: isoOf(profile.updatedAt),
      })),
    );

  const verifyPin = (body: Record<string, unknown>) => {
    const profile = profiles.find(one => one.index === body.p_profile_id);
    if (!profile) return rest(400, "Profile not found", "P0001");
    profile.updatedAt = now();
    if (profile.pin === undefined) return json(200, [{ unlocked: true, retry_after_seconds: 0 }]);
    if (profile.lockedUntil !== undefined && profile.lockedUntil > now())
      return json(200, [
        { unlocked: false, retry_after_seconds: Math.ceil((profile.lockedUntil - now()) / 1000) },
      ]);
    if (body.p_pin === profile.pin) {
      profile.failed = 0;
      profile.lockedUntil = undefined;
      return json(200, [{ unlocked: true, retry_after_seconds: 0 }]);
    }
    profile.failed++;
    if (profile.failed >= PIN_TRIES) {
      profile.failed = 0;
      profile.lockedUntil = now() + PIN_LOCK_MS;
      return json(200, [{ unlocked: false, retry_after_seconds: PIN_LOCK_MS / 1000 }]);
    }
    return json(200, [{ unlocked: false, retry_after_seconds: 0 }]);
  };

  const listRows = () =>
    [...lists]
      // oxlint-disable-next-line unicorn/no-array-sort -- a copy
      .sort((a, b) => a.order - b.order)
      .map(list => ({
        id: list.id,
        name: list.name,
        kind: list.kind,
        url: list.url ?? null,
        server: list.server ?? null,
        username: list.username ?? null,
        password: list.password ?? null,
        guide_urls: list.guideUrls,
        refresh_hours: list.refreshHours,
        disabled: list.disabled,
        profile_ids: list.profiles,
        sort_order: list.order,
      }));

  const addonRows = () =>
    [...addons]
      // oxlint-disable-next-line unicorn/no-array-sort -- a copy
      .sort((a, b) => a.order - b.order)
      .map(addon => ({
        id: addon.id,
        url: addon.url,
        name: addon.name,
        enabled: addon.enabled,
        sort_order: addon.order,
        profile_id: addon.profile,
      }));

  /** A request to the API; an answer as the server's. */
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    calls.push(`${request.method} ${path}`);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (path === "/.well-known/nuvio")
      return json(200, {
        version: 1,
        service: "nuvio",
        self_hosted: true,
        backend_url: site,
        publishable_key: PUBLISHABLE_KEY,
        capabilities: { email_password_auth: true, tv_login: true },
      });
    if (request.headers.get("apikey") !== PUBLISHABLE_KEY)
      return json(401, { message: "No API key found in request" });
    const sent: unknown = request.method === "POST" ? await request.json().catch(() => null) : null;
    const body = isObject(sent) ? sent : {};
    const who = caller(request);
    if (who instanceof Response) return who;

    if (path === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token")
      return refresh(body);
    if (path === "/auth/v1/logout") {
      if (!who)
        return json(401, {
          code: 401,
          error_code: "no_authorization",
          msg: "This endpoint requires a valid Bearer token",
        });
      if (url.searchParams.get("scope") === "global")
        for (const session of sessions.values()) session.ended = true;
      else who.ended = true;
      return json(204, null);
    }
    if (path === "/functions/v1/tv-logins-exchange") return exchange(body);

    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path)?.[1];
    if (rpc === "start_device_login_session" && !options.qrOnly) return startLogin(body, true);
    if (rpc === "start_tv_login_session") return startLogin(body, false);
    if (rpc === "poll_tv_login_session") return pollLogin(body);
    if (rpc !== undefined) {
      const known = ["register_current_device", "sync_pull_profiles", "verify_profile_pin"];
      if (!known.includes(rpc))
        return rest(404, `Could not find the function public.${rpc} in the schema cache`, "PGRST202");
      if (!who) return rest(401, "Unauthorized: valid session required for sync.", "28000");
      if (rpc === "register_current_device") {
        devices.set(String(body.p_installation_id), { ...body, session: who.id });
        return json(200, null);
      }
      if (rpc === "sync_pull_profiles") return pullProfiles();
      return verifyPin(body);
    }
    // Row-level security: the key alone sees no rows.
    if (path === "/rest/v1/addons") return json(200, who ? addonRows() : []);
    if (path === "/rest/v1/velio_iptv_lists") {
      if (options.noIptvLists)
        return rest(
          404,
          "Could not find the table 'public.velio_iptv_lists' in the schema cache",
          "PGRST205",
        );
      return json(200, who ? listRows() : []);
    }
    return json(404, { message: "Not found" });
  };

  return {
    fetch,
    calls,
    /** The owner approves a TV's code: as typed (any case), or as its QR code's address. */
    approve: (typed: string) => {
      if (closed) throw new Error("The account is closed");
      const code = /[?&]code=([^&#]+)/.exec(typed)?.[1] ?? typed.trim();
      const login = logins.get(code) ?? [...logins.values()].find(one => one.userCode === code.toUpperCase());
      if (!login || login.status !== "pending" || login.expiresAt <= now())
        throw new Error("This code doesn't work");
      login.status = "approved";
      return { name: login.name };
    },
    addList,
    /** Changes a list or add-on, by id or name; `profileNames` gives it to those profiles instead. */
    changeList: (idOrName: string, change: Partial<ListDraft>, profileNames?: readonly string[]) => {
      const list = findList(idOrName);
      if (list) {
        Object.assign(list, change);
        if (change.guideUrls) list.guideUrls = change.guideUrls;
        if (profileNames) list.profiles = indexesOf(profileNames);
        return;
      }
      const found = findAddons(idOrName);
      if (found.length === 0) throw new Error(`No list ${idOrName}`);
      for (const addon of found) {
        if (change.name) addon.name = change.name;
        if (change.url) addon.url = change.url;
        if (change.disabled !== undefined) addon.enabled = !change.disabled;
      }
      if (profileNames) {
        const first = found[0];
        for (const addon of found) addons.splice(addons.indexOf(addon), 1);
        for (const index of indexesOf(profileNames))
          addons.push({ ...first, id: `${first.id}-${index}`, profile: index });
      }
    },
    removeList: (idOrName: string) => {
      const list = findList(idOrName);
      if (list) lists.splice(lists.indexOf(list), 1);
      else {
        const found = findAddons(idOrName);
        if (found.length === 0) throw new Error(`No list ${idOrName}`);
        for (const addon of found) addons.splice(addons.indexOf(addon), 1);
      }
    },
    /** Sets a profile's PIN; null takes it off. */
    setPin: (name: string, pin: string | null) => {
      const profile = profileNamed(name);
      if (pin === null) delete profile.pin;
      else profile.pin = pin;
      profile.failed = 0;
      profile.lockedUntil = undefined;
      profile.updatedAt = now();
    },
    renameProfile: (name: string, to: string) => {
      const profile = profileNamed(name);
      profile.name = to;
      profile.updatedAt = now();
    },
    /** Whether a profile uses the main profile's add-ons. */
    usePrimaryAddons: (name: string, uses: boolean) => {
      profileNamed(name).usesPrimaryAddons = uses;
    },
    /** Takes a profile away; the main one stays. */
    removeProfile: (name: string) => {
      const profile = profileNamed(name);
      if (profile.index === 1) throw new Error("The main profile stays");
      profiles.splice(profiles.indexOf(profile), 1);
    },
    /** Signs the TVs out, as the devices page does. */
    removeDevice: () => {
      for (const session of sessions.values()) if (session.tv) session.ended = true;
    },
    close: () => {
      closed = true;
    },
    summary: () => ({
      closed,
      profiles: profiles.map(profile => ({
        index: profile.index,
        name: profile.name,
        pin: profile.pin !== undefined,
      })),
      lists: lists.map(list => ({
        id: list.id,
        name: list.name,
        kind: list.kind,
        profiles: list.profiles.map(
          index => profiles.find(profile => profile.index === index)?.name ?? index,
        ),
      })),
      addons: addons.map(addon => ({
        id: addon.id,
        name: addon.name,
        url: addon.url,
        profile: addon.profile,
      })),
      logins: [...logins.values()].map(login => ({
        name: login.name,
        userCode: login.userCode,
        status: login.status,
      })),
      devices: [...devices.values()].map(device => ({
        name: device.p_device_name,
        client: device.p_client_name,
        platform: device.p_platform,
        signedIn: sessions.get(String(device.session))?.ended === false,
      })),
      tvsSignedIn: tvsSignedIn(),
    }),
  };
};

export type NuvioFake = ReturnType<typeof createNuvioFake>;
