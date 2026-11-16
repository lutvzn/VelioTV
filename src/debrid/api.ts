// Each debrid service's own calls (src/debrid/services.ts): which torrents
// it has, a torrent's file as a link the TV plays, and whether a key works.
// A torrent it doesn't have isn't fetched: TorBox is asked only for one it
// has, and a torrent another service starts fetching is deleted again.
//
// The TorBox, Premiumize and Real-Debrid calls are after NuvioTVSmart's
// js/data/remote/api/debridApi.js and js/core/debrid/directDebridResolver.js
// (https://github.com/NuvioMedia/NuvioTVSmart, GPL-3.0); TorBox's other
// hashes after js/core/debrid/torboxCacheAliases.js. Changed: rewritten in
// TypeScript, with AllDebrid, Debrid-Link, EasyDebrid and Offcloud, whose
// calls follow StremThru's (https://github.com/MunifTanjim/stremthru, MIT).
// Only TorBox has been tried with a real account (PLAN.md, "Debrid
// services"); the others are written from their APIs.

import { ensureFetch } from "../polyfills/fetch";
import { baseName, magnetOf, pickFile, type ServiceFile, type Torrent } from "./files";
import { type ServiceId, serviceInfo } from "./services";

ensureFetch();

/** Why a torrent couldn't be played. */
export type FailKind =
  /** The service doesn't have it. */
  | "notCached"
  /** The key is wrong, or the account has ended. */
  | "key"
  /** The service is down or didn't answer in time. */
  | "busy"
  /** The torrent has no video file. */
  | "noVideo"
  | "failed";

export type DebridFailure = Error & { kind: FailKind };

export const failure = (kind: FailKind, message: string): DebridFailure =>
  Object.assign(new Error(message), { kind });

export const failKind = (error: unknown): FailKind => {
  const kind = typeof error === "object" && error !== null ? (error as { kind?: unknown }).kind : undefined;
  return kind === "notCached" || kind === "key" || kind === "busy" || kind === "noVideo" || kind === "failed"
    ? kind
    : "failed";
};

/** A torrent to play, as the add-on listed it. */
export interface Wanted {
  torrent: Torrent;
  /** The file's name, if the add-on gave it. */
  filename?: string;
}

export interface Resolved {
  url: string;
  filename?: string;
  sizeBytes?: number;
}

export interface ServiceClient {
  /** Of these hashes, those the service has; only on services that can say. */
  check?: (hashes: string[]) => Promise<Set<string>>;
  resolve: (wanted: Wanted) => Promise<Resolved>;
  /** Throws if the key doesn't work. */
  account: () => Promise<void>;
}

export interface ClientOptions {
  fetch?: typeof fetch;
  /** For tests: waits without the clock. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** The app's name, which AllDebrid wants with each call. */
export const AGENT = "VelioTV";
const TIMEOUT_MS = 20_000;
/** How many hashes go in one cache check. */
const CHECK_BATCH = 50;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);
const text = (value: unknown) =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const number = (value: unknown) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const enc = encodeURIComponent;
/** A form's body, as application/x-www-form-urlencoded; older TVs have no URLSearchParams. */
const formBody = (pairs: [string, string][]) =>
  pairs.map(([key, value]) => `${enc(key)}=${enc(value)}`).join("&");
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const JSON_TYPE = { "Content-Type": "application/json" };
const chunks = <T>(all: T[], size: number) => {
  const out: T[][] = [];
  for (let at = 0; at < all.length; at += size) out.push(all.slice(at, at + size));
  return out;
};

export interface Answer {
  status: number;
  ok: boolean;
  body: unknown;
}

export type Http = (url: string, init?: RequestInit) => Promise<Answer>;

/** Asks the service, giving up after `timeoutMs`; the body read as JSON, else as text. */
export const httpFor =
  (name: string, fetcher: typeof fetch, timeoutMs: number): Http =>
  async (url, init) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(failure("busy", `${name} didn't answer in time`)), timeoutMs);
    });
    try {
      const response = await Promise.race([fetcher(url, init), timeout]);
      const raw = await Promise.race([response.text(), timeout]);
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        // Not JSON: kept as text.
      }
      return { status: response.status, ok: response.ok, body };
    } catch (error) {
      if (failKind(error) !== "failed") throw error;
      throw failure("busy", `${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  };

/** Throws for a refused key, and for a service that's down. */
const checkAnswer = (name: string, answer: Answer) => {
  if (answer.status === 401 || answer.status === 403) throw failure("key", `${name} refused the key`);
  if (answer.status >= 500) throw failure("busy", `${name} answered ${answer.status}`);
};

/** The first file's link, or why there's none. */
const fileLink = (files: ServiceFile[], wanted: Wanted, name: string) => {
  const file = pickFile(files, wanted.torrent, wanted.filename);
  if (!file) throw failure("noVideo", `${name} found no video in the torrent`);
  return file;
};

const resolved = (url: string, file: ServiceFile): Resolved => ({
  url,
  filename: baseName(file.name),
  ...(file.size > 0 ? { sizeBytes: file.size } : {}),
});

const plainHash = (wanted: Wanted) => magnetOf(wanted.torrent);

/** TorBox's words for an error. */
const detail = (body: unknown) => `${text(field(body, "error"))} ${text(field(body, "detail"))}`.trim();

// TorBox: https://api.torbox.app/v1/api/, with the key as a Bearer token.
const torbox = (key: string, http: Http): ServiceClient => {
  const base = "https://api.torbox.app/v1/api/";
  const auth = { Authorization: `Bearer ${key}` };
  const name = "TorBox";
  const checkOnce = async (hashes: string[]) => {
    const answer = await http(`${base}torrents/checkcached?format=object&list_files=false`, {
      method: "POST",
      headers: { ...auth, ...JSON_TYPE },
      body: JSON.stringify({ hashes }),
    });
    checkAnswer(name, answer);
    const data = field(answer.body, "data");
    return isObject(data) ? Object.keys(data).map(hash => hash.toLowerCase()) : [];
  };
  return {
    check: async hashes => {
      const found = new Set<string>();
      for (const batch of chunks(hashes, CHECK_BATCH)) {
        const keys = await checkOnce(batch);
        const asked = new Set(batch);
        for (const hash of keys) if (asked.has(hash)) found.add(hash);
        // TorBox answers with its own hash for a torrent it knows by another,
        // so each one not found is asked alone, where any answer is its.
        if (!keys.some(hash => !asked.has(hash))) continue;
        const missing = batch.filter(hash => !found.has(hash));
        if (batch.length === 1) {
          found.add(batch[0]);
          continue;
        }
        const singles = await Promise.all(
          missing.slice(0, 10).map(hash => checkOnce([hash]).catch((): string[] => [])),
        );
        singles.forEach((one, at) => {
          if (one.length > 0) found.add(missing[at]);
        });
      }
      return found;
    },
    resolve: async wanted => {
      const form = new FormData();
      form.append("magnet", plainHash(wanted));
      form.append("add_only_if_cached", "true");
      form.append("allow_zip", "false");
      const made = await http(`${base}torrents/createtorrent`, { method: "POST", headers: auth, body: form });
      if (made.status === 409) throw failure("notCached", `${name} doesn't have it`);
      checkAnswer(name, made);
      const data = field(made.body, "data");
      const id = text(field(data, "torrent_id")) || text(field(data, "id"));
      if (!id) {
        const why = detail(made.body);
        if (/cach/i.test(why)) throw failure("notCached", `${name} doesn't have it`);
        throw failure("failed", why || `${name} answered ${made.status}`);
      }
      const listed = await http(`${base}torrents/mylist?id=${enc(id)}&bypass_cache=true`, { headers: auth });
      checkAnswer(name, listed);
      const files = list(field(field(listed.body, "data"), "files")).map((file): ServiceFile => ({
        id: text(field(file, "id")),
        name: text(field(file, "name")) || text(field(file, "short_name")),
        size: number(field(file, "size")),
        mime: text(field(file, "mimetype")),
      }));
      // A torrent already in the account is given back as it is, even one still
      // fetching: that one isn't there to play yet.
      const item = field(listed.body, "data");
      const finished = field(item, "download_finished");
      if ((finished === false && field(item, "cached") !== true) || (files.length === 0 && finished !== true))
        throw failure("notCached", `${name} doesn't have it yet`);
      const file = fileLink(files, wanted, name);
      const link = await http(
        `${base}torrents/requestdl?token=${enc(key)}&torrent_id=${enc(id)}&file_id=${enc(file.id)}` +
          "&zip_link=false&redirect=false&append_name=false",
        { headers: auth },
      );
      checkAnswer(name, link);
      const url = text(field(link.body, "data"));
      if (!/^https?:/i.test(url)) throw failure("failed", detail(link.body) || `${name} gave no link`);
      return resolved(url, file);
    },
    account: async () => {
      const answer = await http(`${base}user/me`, { headers: auth });
      checkAnswer(name, answer);
      if (!answer.ok || field(answer.body, "success") === false)
        throw failure("key", `${name} refused the key`);
    },
  };
};

/** A Real-Debrid torrent's state, such as "downloaded". */
const status = (body: unknown) => text(field(body, "status"));
/** A Real-Debrid torrent's files, and whether each is chosen. */
const filesOf = (body: unknown) =>
  list(field(body, "files")).map((file): ServiceFile & { selected: boolean } => ({
    id: text(field(file, "id")),
    name: text(field(file, "path")),
    size: number(field(file, "bytes")),
    selected: field(file, "selected") === 1,
  }));

// Real-Debrid: https://api.real-debrid.com/rest/1.0/, with a Bearer token.
// It can't say what it has: the torrent is added, its file chosen, and it's
// deleted again unless it's there at once.
const realDebrid = (key: string, http: Http, sleep: (ms: number) => Promise<void>): ServiceClient => {
  const base = "https://api.real-debrid.com/rest/1.0/";
  const auth = { Authorization: `Bearer ${key}` };
  const name = "Real-Debrid";
  const info = async (id: string) => {
    const answer = await http(`${base}torrents/info/${enc(id)}`, { headers: auth });
    checkAnswer(name, answer);
    return answer.body;
  };
  const drop = (id: string) =>
    http(`${base}torrents/delete/${enc(id)}`, { method: "DELETE", headers: auth }).catch(() => undefined);
  return {
    resolve: async wanted => {
      const added = await http(`${base}torrents/addMagnet`, {
        method: "POST",
        headers: { ...auth, ...FORM },
        body: formBody([["magnet", plainHash(wanted)]]),
      });
      checkAnswer(name, added);
      const id = text(field(added.body, "id"));
      if (!id)
        throw failure("failed", text(field(added.body, "error")) || `${name} answered ${added.status}`);
      let keep = false;
      try {
        let now = await info(id);
        for (let tries = 0; status(now) === "magnet_conversion" && tries < 5; tries++) {
          await sleep(1000);
          now = await info(id);
        }
        let file: ServiceFile | undefined;
        if (status(now) === "waiting_files_selection") {
          file = fileLink(filesOf(now), wanted, name);
          const chosen = await http(`${base}torrents/selectFiles/${enc(id)}`, {
            method: "POST",
            headers: { ...auth, ...FORM },
            body: formBody([["files", file.id]]),
          });
          checkAnswer(name, chosen);
          now = await info(id);
          for (let tries = 0; status(now) === "queued" && tries < 2; tries++) {
            await sleep(1000);
            now = await info(id);
          }
        }
        if (status(now) !== "downloaded") throw failure("notCached", `${name} doesn't have it`);
        // Its links are those of the files chosen, in order.
        const selected = filesOf(now).filter(one => one.selected);
        file ??= fileLink(selected, wanted, name);
        const at = Math.max(
          0,
          selected.findIndex(one => one.id === file?.id),
        );
        const link = text(list(field(now, "links"))[at]);
        if (!link) throw failure("failed", `${name} gave no link`);
        const unrestricted = await http(`${base}unrestrict/link`, {
          method: "POST",
          headers: { ...auth, ...FORM },
          body: formBody([["link", link]]),
        });
        checkAnswer(name, unrestricted);
        const url = text(field(unrestricted.body, "download"));
        if (!/^https?:/i.test(url))
          throw failure("failed", text(field(unrestricted.body, "error")) || `${name} gave no link`);
        keep = true;
        return {
          url,
          filename: text(field(unrestricted.body, "filename")) || baseName(file.name),
          ...(number(field(unrestricted.body, "filesize"))
            ? { sizeBytes: number(field(unrestricted.body, "filesize")) }
            : {}),
        };
      } finally {
        if (!keep) void drop(id);
      }
    },
    account: async () => {
      const answer = await http(`${base}user`, { headers: auth });
      checkAnswer(name, answer);
      if (!answer.ok) throw failure("key", `${name} refused the key`);
    },
  };
};

/** Premiumize's answer for a key it doesn't take. */
const refused = (body: unknown) => /log(ged)? ?in|api ?key|customer/i.test(text(field(body, "message")));

// Premiumize: https://www.premiumize.me/api/, with the key in each address.
const premiumize = (key: string, http: Http): ServiceClient => {
  const base = "https://www.premiumize.me/api/";
  const name = "Premiumize";
  const withKey = (path: string) => `${base}${path}${path.includes("?") ? "&" : "?"}apikey=${enc(key)}`;
  return {
    check: async hashes => {
      const found = new Set<string>();
      for (const batch of chunks(hashes, CHECK_BATCH)) {
        const answer = await http(withKey("cache/check"), {
          method: "POST",
          headers: FORM,
          body: formBody(batch.map(hash => ["items[]", hash] as [string, string])),
        });
        checkAnswer(name, answer);
        if (text(field(answer.body, "status")) !== "success") {
          if (refused(answer.body)) throw failure("key", `${name} refused the key`);
          continue;
        }
        list(field(answer.body, "response")).forEach((cached, at) => {
          if (cached === true && batch[at]) found.add(batch[at]);
        });
      }
      return found;
    },
    resolve: async wanted => {
      const answer = await http(withKey("transfer/directdl"), {
        method: "POST",
        headers: FORM,
        body: formBody([["src", plainHash(wanted)]]),
      });
      checkAnswer(name, answer);
      if (text(field(answer.body, "status")) !== "success") {
        if (refused(answer.body)) throw failure("key", `${name} refused the key`);
        throw failure("notCached", text(field(answer.body, "message")) || `${name} doesn't have it`);
      }
      const files = list(field(answer.body, "content")).map((file, at): ServiceFile => ({
        id: String(at),
        name: text(field(file, "path")),
        size: number(field(file, "size")),
        link: text(field(file, "link")) || text(field(file, "stream_link")),
      }));
      if (files.length === 0) throw failure("notCached", `${name} doesn't have it`);
      const file = fileLink(files, wanted, name);
      if (!file.link) throw failure("failed", `${name} gave no link`);
      return resolved(file.link, file);
    },
    account: async () => {
      const answer = await http(withKey("account/info"));
      checkAnswer(name, answer);
      if (text(field(answer.body, "status")) !== "success") throw failure("key", `${name} refused the key`);
    },
  };
};

// AllDebrid: https://api.alldebrid.com/, with a Bearer token and the app's
// name. It can't say what it has either: the torrent is added, and deleted
// again unless it's ready at once.
const allDebrid = (key: string, http: Http): ServiceClient => {
  const base = "https://api.alldebrid.com/";
  const auth = { Authorization: `Bearer ${key}` };
  const name = "AllDebrid";
  const address = (path: string, query = "") => `${base}${path}?agent=${enc(AGENT)}${query}`;
  const data = (answer: Answer) => {
    checkAnswer(name, answer);
    if (text(field(answer.body, "status")) === "success") return field(answer.body, "data");
    const error = field(answer.body, "error");
    const code = text(field(error, "code"));
    if (code.startsWith("AUTH_")) throw failure("key", `${name} refused the key`);
    throw failure("failed", text(field(error, "message")) || code || `${name} answered ${answer.status}`);
  };
  /** Its files are a tree: each has a name (n), and a size (s) and link (l), or more inside (e). */
  const flatten = (nodes: unknown, path: string, into: ServiceFile[]) => {
    for (const node of list(nodes)) {
      const at = path ? `${path}/${text(field(node, "n"))}` : text(field(node, "n"));
      const inside = field(node, "e");
      if (Array.isArray(inside)) flatten(inside, at, into);
      else
        into.push({
          id: String(into.length),
          name: at,
          size: number(field(node, "s")),
          link: text(field(node, "l")),
        });
    }
    return into;
  };
  return {
    resolve: async wanted => {
      const uploaded = data(
        await http(address("v4/magnet/upload"), {
          method: "POST",
          headers: { ...auth, ...FORM },
          body: formBody([["magnets[]", plainHash(wanted)]]),
        }),
      );
      const magnet = list(field(uploaded, "magnets"))[0];
      const error = field(magnet, "error");
      if (error) throw failure("failed", text(field(error, "message")) || `${name} couldn't add it`);
      const id = text(field(magnet, "id"));
      if (!id) throw failure("failed", `${name} couldn't add it`);
      if (field(magnet, "ready") !== true) {
        void http(address("v4/magnet/delete", `&id=${enc(id)}`), { headers: auth }).catch(() => undefined);
        throw failure("notCached", `${name} doesn't have it`);
      }
      const listed = data(await http(address("v4/magnet/files", `&id[]=${enc(id)}`), { headers: auth }));
      const files = flatten(field(list(field(listed, "magnets"))[0], "files"), "", []);
      const file = fileLink(files, wanted, name);
      const unlocked = data(
        await http(address("v4/link/unlock", `&link=${enc(file.link ?? "")}`), { headers: auth }),
      );
      const url = text(field(unlocked, "link"));
      if (!/^https?:/i.test(url)) throw failure("busy", `${name} gave no link yet`);
      return resolved(url, file);
    },
    account: async () => {
      data(await http(address("v4/user"), { headers: auth }));
    },
  };
};

// Debrid-Link: https://debrid-link.com/api/v2/, with a Bearer token. The
// torrent is added to its seedbox, and deleted again unless it's all there.
const debridLink = (key: string, http: Http): ServiceClient => {
  const base = "https://debrid-link.com/api/v2/";
  const auth = { Authorization: `Bearer ${key}` };
  const name = "Debrid-Link";
  const value = (answer: Answer) => {
    checkAnswer(name, answer);
    if (field(answer.body, "success") === true) return field(answer.body, "value");
    const code = text(field(answer.body, "error"));
    if (/token|auth/i.test(code)) throw failure("key", `${name} refused the key`);
    throw failure("failed", code || `${name} answered ${answer.status}`);
  };
  return {
    resolve: async wanted => {
      const added = value(
        await http(`${base}seedbox/add`, {
          method: "POST",
          headers: { ...auth, ...JSON_TYPE },
          body: JSON.stringify({ url: plainHash(wanted), wait: false, async: false, structureType: "list" }),
        }),
      );
      const id = text(field(added, "id"));
      if (number(field(added, "downloadPercent")) < 100) {
        if (id)
          void http(`${base}seedbox/${enc(id)}/remove`, { method: "DELETE", headers: auth }).catch(
            () => undefined,
          );
        throw failure("notCached", `${name} doesn't have it`);
      }
      const files = list(field(added, "files")).map((file): ServiceFile => ({
        id: text(field(file, "id")),
        name: text(field(file, "name")),
        size: number(field(file, "size")),
        link: text(field(file, "downloadUrl")),
      }));
      const file = fileLink(files, wanted, name);
      if (!file.link) throw failure("failed", `${name} gave no link`);
      return resolved(file.link, file);
    },
    account: async () => {
      value(await http(`${base}account/infos`, { headers: auth }));
    },
  };
};

// EasyDebrid: https://easydebrid.com/api/v1/, with a Bearer token.
const easyDebrid = (key: string, http: Http): ServiceClient => {
  const base = "https://easydebrid.com/api/v1/";
  const auth = { Authorization: `Bearer ${key}` };
  const name = "EasyDebrid";
  const post = async (path: string, body: unknown) => {
    const answer = await http(`${base}${path}`, {
      method: "POST",
      headers: { ...auth, ...JSON_TYPE },
      body: JSON.stringify(body),
    });
    checkAnswer(name, answer);
    const error = text(field(answer.body, "error"));
    if (error) throw failure(/auth|token|key/i.test(error) ? "key" : "failed", `${name}: ${error}`);
    return answer.body;
  };
  return {
    check: async hashes => {
      const found = new Set<string>();
      for (const batch of chunks(hashes, CHECK_BATCH)) {
        const body = await post("link/lookupdetails", {
          urls: batch.map(hash => `magnet:?xt=urn:btih:${hash}`),
        });
        list(field(body, "result")).forEach((item, at) => {
          if (field(item, "cached") === true && batch[at]) found.add(batch[at]);
        });
      }
      return found;
    },
    resolve: async wanted => {
      const body = await post("link/generate", { url: plainHash(wanted) });
      const files = list(field(body, "files")).map((file, at): ServiceFile => ({
        id: String(at),
        name: [...list(field(file, "directory")).map(text), text(field(file, "filename"))].join("/"),
        size: number(field(file, "size")),
        link: text(field(file, "url")),
      }));
      if (files.length === 0) throw failure("notCached", `${name} doesn't have it`);
      const file = fileLink(files, wanted, name);
      if (!file.link) throw failure("failed", `${name} gave no link`);
      return resolved(file.link, file);
    },
    account: async () => {
      const answer = await http(`${base}user/details`, { headers: auth });
      checkAnswer(name, answer);
      if (!answer.ok || text(field(answer.body, "error"))) throw failure("key", `${name} refused the key`);
    },
  };
};

// Offcloud: https://offcloud.com/api/, with a Bearer token. A torrent it
// doesn't have would be fetched into the account, so it's checked first.
const offcloud = (key: string, http: Http): ServiceClient => {
  const base = "https://offcloud.com/api/";
  const auth = { Authorization: `Bearer ${key}` };
  const name = "Offcloud";
  const refusedIf = (answer: Answer) => {
    checkAnswer(name, answer);
    if (text(field(answer.body, "error")) === "NOAUTH") throw failure("key", `${name} refused the key`);
  };
  const check = async (hashes: string[]) => {
    const found = new Set<string>();
    for (const batch of chunks(hashes, CHECK_BATCH)) {
      const answer = await http(`${base}cache/info`, {
        method: "POST",
        headers: { ...auth, ...JSON_TYPE },
        body: JSON.stringify({ urls: batch.map(hash => `magnet:?xt=urn:btih:${hash}`) }),
      });
      refusedIf(answer);
      list(answer.body).forEach((item, at) => {
        if (field(item, "cached") === true && batch[at]) found.add(batch[at]);
      });
    }
    return found;
  };
  return {
    check,
    resolve: async wanted => {
      const hash = wanted.torrent.infoHash;
      if (!(await check([hash])).has(hash)) throw failure("notCached", `${name} doesn't have it`);
      const added = await http(`${base}cloud`, {
        method: "POST",
        headers: { ...auth, ...JSON_TYPE },
        body: JSON.stringify({ url: plainHash(wanted) }),
      });
      refusedIf(added);
      const id = text(field(added.body, "requestId"));
      if (!id) throw failure("failed", text(field(added.body, "error")) || `${name} couldn't add it`);
      if (text(field(added.body, "status")) !== "downloaded")
        throw failure("notCached", `${name} doesn't have it yet`);
      const explored = await http(`${base}cloud/explore/${enc(id)}?format=detailed`, { headers: auth });
      refusedIf(explored);
      const files = list(field(explored.body, "files")).map((file): ServiceFile => ({
        id: text(field(file, "id")),
        name: text(field(file, "path")) || text(field(file, "name")),
        size: number(field(file, "size")),
        link: text(field(file, "url")),
      }));
      // A torrent of one file isn't a folder to explore: the download is its link.
      const single = text(field(added.body, "url"));
      if (files.length === 0 && single)
        return { url: single, filename: text(field(added.body, "fileName")) || undefined };
      const file = fileLink(files, wanted, name);
      if (!file.link) throw failure("failed", `${name} gave no link`);
      return resolved(file.link, file);
    },
    account: async () => {
      const answer = await http(`${base}account/info`, { headers: auth });
      refusedIf(answer);
      if (!answer.ok) throw failure("key", `${name} refused the key`);
    },
  };
};

/** The service's calls with this key. */
export const clientFor = (id: ServiceId, key: string, options: ClientOptions = {}): ServiceClient => {
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const http = httpFor(serviceInfo(id).name, fetcher, options.timeoutMs ?? TIMEOUT_MS);
  const makers: Record<ServiceId, () => ServiceClient> = {
    torbox: () => torbox(key, http),
    realdebrid: () => realDebrid(key, http, sleep),
    premiumize: () => premiumize(key, http),
    alldebrid: () => allDebrid(key, http),
    debridlink: () => debridLink(key, http),
    easydebrid: () => easyDebrid(key, http),
    offcloud: () => offcloud(key, http),
  };
  return makers[id]();
};
