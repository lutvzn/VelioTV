// A made-up Velio Sync account and the /v1 a TV talks to (VelioPlatform's
// PLAN.md, "VelioTV changes": "a mock /v1 so the TV can be tested without
// Cloudflare"), for VelioTV's tests and the test server. It runs sync-core's
// own server side (applyChange(), pullFor()) and plays the owner's phone,
// so the TV's half is tested against the same formats and checks as on
// velio.tv. Nothing is kept: a new mock is a new account.
//
// The TV's routes, as on velio.tv (VelioPlatform's apps/sync/src/routes/tv.ts):
//   POST /v1/pair, GET /v1/pair/:id (waits up to 20 s, or ?wait=),
//   GET /v1/sync (304 for the same revision), POST /v1/signout,
//   and the events socket, through connect().
// What the owner does, on the web there, is methods here: approve() a TV's
// code, addList(), removeList(), setPin(), setDeviceProfiles(),
// removeDevice(), close() the account.
//
// The account starts with three profiles ("Living room", "Kids", "Guest")
// and lists from `base`, the test server: "Test channels" (50 channels, for
// Living room and Kids), "Kids channels" (Kids), "Test Xtream" (the small
// login, Living room) and "Guest channels" (Guest).

import {
  applyChange,
  buildChange,
  newId,
  newOwnerKeys,
  newPairingId,
  openDeviceInfo,
  openState,
  ownerPublicKeys,
  pairingProof,
  pullFor,
  readPairingCode,
  revEvent,
  REMOVED_EVENT,
  EVENTS_CLOSE,
  PAIRING_MS,
  PING,
  PONG,
  sealPairingPayload,
  storedManifest,
  withDevice,
  withDeviceProfiles,
  withList,
  withoutDevice,
  withoutList,
  withProfile,
  fromBase64,
  isRecord,
  isSealed,
  toBase64,
  type ListDraft,
  type OpenedState,
  type SealedDeviceInfo,
  type StoredState,
} from "../../src/sync-core";

export const MOCK_ACCOUNT = "test-account";
const MAX_WAIT_S = 20;

interface Pairing {
  id: string;
  pollToken: string;
  expiresAt: number;
  deviceId: string;
  publicKey: string;
  name: string;
  sealed: SealedDeviceInfo;
  proofs: { qr: string; code: string };
  answer?: { deviceToken: string; kind: "qr" | "code"; payload: unknown };
  delivered?: boolean;
}

export interface EventsSocket {
  send: (text: string) => void;
  close: (code: number) => void;
}

const randomToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });
const problem = (status: number, text: string) => json(status, { problem: text });

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "ETag",
};

const bearer = (request: Request) =>
  /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("Authorization") ?? "")?.[1];

export const testList = (base: string, name: string, channels = 50): ListDraft => ({
  name,
  kind: "m3u",
  url: `${base}/playlist.m3u?channels=${channels}&days=2&list=${encodeURIComponent(name)}`,
  refreshHours: 24,
});

/** The test server's made-up Stremio add-on (stremio.mjs), as a list. */
export const testAddon = (base: string, name: string): ListDraft => ({
  name,
  kind: "stremio",
  url: `${base}/stremio/manifest.json`,
  refreshHours: 24,
});

export const createSyncMock = (options: { base: string; now?: () => number }) => {
  const now = options.now ?? Date.now;
  const owner = newOwnerKeys();
  let stored: StoredState = { manifest: null, profiles: [], lists: [], devices: [] };
  let closed = false;
  const pairings = new Map<string, Pairing>();
  /** Device tokens: token → TV id. */
  const tokens = new Map<string, string>();
  const signedOut = new Set<string>();
  const sockets = new Map<string, EventsSocket>();
  const waiters = new Set<() => void>();

  const open = () => openState(owner, MOCK_ACCOUNT, stored);
  const rev = () => storedManifest(stored, MOCK_ACCOUNT).rev;
  const changed = () => {
    for (const wake of waiters) wake();
    for (const socket of sockets.values()) socket.send(revEvent(rev()));
  };
  /** The owner's change, as the web makes it and the server checks it. */
  const save = (edit: (state: OpenedState) => OpenedState, newDevices: string[] = []) => {
    const before = open();
    const change = JSON.parse(JSON.stringify(buildChange(owner, before, edit(before)))) as unknown;
    stored = applyChange(stored, change, MOCK_ACCOUNT, owner.signing.publicKey, { newDevices }).state;
    changed();
  };

  const profileIds: Record<string, string> = {};
  save(state => {
    let next = state;
    for (const name of ["Living room", "Kids", "Guest"]) {
      const made = withProfile(next, { name });
      profileIds[name] = made.profileId;
      next = made.state;
    }
    const { base } = options;
    next = withList(next, testList(base, "Test channels"), [
      profileIds["Living room"],
      profileIds.Kids,
    ]).state;
    next = withList(next, testList(base, "Kids channels", 20), [profileIds.Kids]).state;
    next = withList(
      next,
      {
        name: "Test Xtream",
        kind: "xtream",
        server: base,
        username: "small",
        password: "small",
        refreshHours: 24,
      },
      [profileIds["Living room"]],
    ).state;
    return withList(next, testList(base, "Guest channels", 10), [profileIds.Guest]).state;
  });

  /** A profile's id from its name or id. */
  const profileId = (nameOrId: string) => {
    const found = open().profiles.find(
      profile => profile.record.id === nameOrId || profile.record.name === nameOrId,
    );
    if (!found) throw new Error(`No profile ${nameOrId}`);
    return found.record.id;
  };
  const listId = (nameOrId: string) => {
    const found = open().lists.find(list => list.record.id === nameOrId || list.record.name === nameOrId);
    if (!found) throw new Error(`No list ${nameOrId}`);
    return found.record.id;
  };
  /** The TV signed in last, for owner actions that don't name one. */
  const deviceId = (id?: string) => {
    const devices = open().devices;
    const found = id ? devices.find(device => device.id === id) : devices[devices.length - 1];
    if (!found) throw new Error(id ? `No TV ${id}` : "No TV is signed in");
    return found.id;
  };

  /** Ends a TV's sign-in: its token stops working, and its socket hears so. */
  const dropDevice = (id: string) => {
    for (const [token, device] of tokens) if (device === id) tokens.delete(token);
    const socket = sockets.get(id);
    if (socket) {
      sockets.delete(id);
      socket.send(REMOVED_EVENT);
      socket.close(EVENTS_CLOSE.removed);
    }
  };

  const until = (deadline: number) =>
    new Promise<void>(resolve => {
      const wake = () => {
        waiters.delete(wake);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(0, deadline - now()));
      waiters.add(wake);
    });

  const routes = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/v1/pair" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body.publicKey !== "string" || typeof body.name !== "string")
        return problem(400, "Send JSON.");
      const { sealed, proofs } = body;
      if (
        !isRecord(sealed) ||
        !isSealed(sealed.qr) ||
        !isSealed(sealed.code) ||
        !isRecord(proofs) ||
        typeof proofs.qr !== "string" ||
        typeof proofs.code !== "string"
      )
        return problem(400, "Send the sealed device info and proofs.");
      const pairing: Pairing = {
        id: newPairingId(),
        pollToken: randomToken(),
        expiresAt: now() + PAIRING_MS,
        deviceId: newId(),
        publicKey: body.publicKey,
        name: body.name,
        sealed: { qr: sealed.qr, code: sealed.code },
        proofs: { qr: proofs.qr, code: proofs.code },
      };
      pairings.set(pairing.id, pairing);
      return json(201, { id: pairing.id, pollToken: pairing.pollToken, expiresAt: pairing.expiresAt });
    }

    const pair = /^\/v1\/pair\/([0-9A-Z]{4})$/.exec(url.pathname);
    if (pair && request.method === "GET") {
      const pairing = pairings.get(pair[1]);
      if (!pairing || bearer(request) !== pairing.pollToken) return problem(404, "No such sign-in.");
      const seconds = Math.min(
        MAX_WAIT_S,
        Math.max(0, Number(url.searchParams.get("wait") ?? MAX_WAIT_S) || 0),
      );
      const deadline = now() + seconds * 1000;
      for (;;) {
        if (pairing.delivered) return problem(410, "This sign-in was already picked up.");
        if (pairing.answer) {
          pairing.delivered = true;
          return json(200, { status: "done", deviceId: pairing.deviceId, ...pairing.answer });
        }
        if (pairing.expiresAt <= now()) return problem(410, "This sign-in expired. Start again.");
        if (now() >= deadline) return json(200, { status: "waiting", expiresAt: pairing.expiresAt });
        await until(deadline);
      }
    }

    if (url.pathname === "/v1/sync" && request.method === "GET") {
      const token = bearer(request);
      const device = token && !closed ? tokens.get(token) : undefined;
      if (!device) return problem(401, "Sign in again.");
      const pull = pullFor(stored, device);
      if (!pull) return problem(401, "This TV was removed from the account. Sign in again.");
      const headers = { ETag: `"${rev()}"`, "Cache-Control": "no-store" };
      if (request.headers.get("If-None-Match") === `"${rev()}"`)
        return new Response(null, { status: 304, headers: { ...CORS, ...headers } });
      return json(200, pull, headers);
    }

    if (url.pathname === "/v1/signout" && request.method === "POST") {
      const token = bearer(request);
      const device = token ? tokens.get(token) : undefined;
      if (!device) return problem(401, "Sign in again.");
      signedOut.add(device);
      dropDevice(device);
      return new Response(null, { status: 204, headers: CORS });
    }
    return problem(404, "Not found.");
  };

  return {
    /** Answers a TV's request to /v1, as velio.tv does. */
    fetch: (request: Request) => routes(request),

    /**
     * Opens a TV's events socket; undefined refuses it, as the server does a
     * wrong token. Feed it what the TV sends; tell it when the TV closes.
     */
    connect: (token: string | undefined, socket: EventsSocket) => {
      const device = token && !closed ? tokens.get(token) : undefined;
      if (!device) return undefined;
      // A newer socket of the same TV takes the place of the old one.
      sockets.get(device)?.close(EVENTS_CLOSE.replaced);
      sockets.set(device, socket);
      socket.send(revEvent(rev()));
      return {
        message: (text: string) => {
          if (text === PING) socket.send(PONG);
        },
        closed: () => {
          if (sockets.get(device) === socket) sockets.delete(device);
        },
      };
    },

    // --- The owner, on the web ---

    /** The phone reading the TV's QR address or typed code, giving it these profiles (names or ids; all by default). */
    approve: (code: string, profiles?: string[]) => {
      const read = readPairingCode(code);
      if (!read) throw new Error("That isn't a code");
      const pairing = pairings.get(read.id);
      if (!pairing || pairing.expiresAt <= now() || pairing.answer) throw new Error("No such TV is waiting");
      if (pairingProof(read.kind, read.secret) !== pairing.proofs[read.kind]) throw new Error("Wrong code");
      const info = openDeviceInfo(read, pairing.sealed);
      const chosen = (profiles ?? open().profiles.map(profile => profile.record.id)).map(profileId);
      save(
        state => withDevice(state, pairing.deviceId, fromBase64(info.publicKey), chosen),
        [pairing.deviceId],
      );
      const deviceToken = randomToken();
      tokens.set(deviceToken, pairing.deviceId);
      pairing.answer = {
        deviceToken,
        kind: read.kind,
        payload: sealPairingPayload(read, {
          format: 1,
          account: MOCK_ACCOUNT,
          device: pairing.deviceId,
          devicePublicKey: info.publicKey,
          ...ownerPublicKeys(owner),
        }),
      };
      for (const wake of waiters) wake();
      return { device: pairing.deviceId, name: info.name };
    },
    /** Adds a list for these profiles (names or ids). */
    addList: (draft: ListDraft, profiles: string[]) => {
      let id = "";
      save(state => {
        const made = withList(state, draft, profiles.map(profileId));
        id = made.listId;
        return made.state;
      });
      return id;
    },
    /** Changes a list's settings or profiles, keeping what isn't given. */
    changeList: (nameOrId: string, change: Partial<ListDraft>, profiles?: string[]) => {
      const id = listId(nameOrId);
      save(state => {
        const list = state.lists.find(item => item.record.id === id);
        if (!list) throw new Error(`No list ${nameOrId}`);
        const { format: _format, id: _id, rev: _rev, ...draft } = list.record;
        return withList(
          state,
          { ...draft, ...change },
          profiles ? profiles.map(profileId) : list.profiles,
          id,
        ).state;
      });
    },
    removeList: (nameOrId: string) => {
      const id = listId(nameOrId);
      save(state => withoutList(state, id));
    },
    /** Sets a profile's PIN, or with null removes it. */
    setPin: (profile: string, pin: string | null) => {
      const id = profileId(profile);
      save(state => {
        const record = state.profiles.find(item => item.record.id === id)?.record;
        return withProfile(state, { name: record?.name ?? "", pin }, id).state;
      });
    },
    renameProfile: (profile: string, name: string) => {
      const id = profileId(profile);
      save(state => withProfile(state, { name }, id).state);
    },
    /** Changes which profiles a TV has (the last signed in by default). */
    setDeviceProfiles: (profiles: string[], device?: string) => {
      const id = deviceId(device);
      save(state => withDeviceProfiles(state, id, profiles.map(profileId)));
    },
    /** Removes a TV from the account (the last signed in by default). */
    removeDevice: (device?: string) => {
      const id = deviceId(device);
      save(state => withoutDevice(state, id));
      dropDevice(id);
    },
    /** Closes the account, as after a notice: every TV's token stops working. */
    close: () => {
      closed = true;
      for (const id of new Set(tokens.values())) dropDevice(id);
    },

    /** What the account holds, by name, and the TVs waiting to sign in; for tests and the test server's page. */
    summary: () => {
      const state = open();
      const names = new Map(state.profiles.map(profile => [profile.record.id, profile.record.name]));
      return {
        account: MOCK_ACCOUNT,
        rev: rev(),
        closed,
        profiles: state.profiles.map(profile => ({
          id: profile.record.id,
          name: profile.record.name,
          pin: profile.record.pin ?? null,
        })),
        lists: state.lists.map(list => ({
          id: list.record.id,
          name: list.record.name,
          rev: list.record.rev,
          profiles: list.profiles.map(id => names.get(id)),
        })),
        devices: state.devices.map(device => ({
          id: device.id,
          profiles: device.profiles.map(id => names.get(id)),
          signedIn: [...tokens.values()].includes(device.id),
          signedOut: signedOut.has(device.id),
          socket: sockets.has(device.id),
        })),
        waiting: [...pairings.values()]
          .filter(pairing => !pairing.answer && pairing.expiresAt > now())
          .map(pairing => ({ id: pairing.id, name: pairing.name })),
      };
    },
  };
};

export type SyncMock = ReturnType<typeof createSyncMock>;
