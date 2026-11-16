// The profile's debrid service at work (src/debrid/services.ts): whether it
// has each torrent the add-ons list, asked of services that can say, and a
// torrent's link to play, kept for a while, each asked once at a time.
//
// After NuvioTVSmart's js/core/debrid/directDebridResolver.js and
// js/core/debrid/localDebridAvailabilityService.js
// (https://github.com/NuvioMedia/NuvioTVSmart, GPL-3.0); changed: rewritten
// in TypeScript, with a Solid signal for what's been checked.

import { createRoot, createSignal } from "solid-js";
import { clientFor, failKind, failure, type Resolved, type ServiceClient, type Wanted } from "./api";
import { type ServiceId, serviceInfo } from "./services";

/** Whether the service has a torrent: still asking, yes, no, or it can't say. */
export type CacheState = "checking" | "cached" | "notCached" | "unknown";

export interface Active {
  service: ServiceId;
  key: string;
}

/** How long a link and a check's answer are kept. */
export const DEBRID_KEPT_MS = 15 * 60_000;
/** How long a check that failed is kept, before it's asked again. */
const FAILED_KEPT_MS = 60_000;
const LINKS_KEPT = 100;
const STATES_KEPT = 2000;

export const createDebrid = (options: {
  active: () => Active | undefined;
  client?: (id: ServiceId, key: string) => ServiceClient;
  now?: () => number;
}) =>
  createRoot(() => {
    const makeClient = options.client ?? ((id: ServiceId, key: string) => clientFor(id, key));
    const now = options.now ?? (() => Date.now());
    let kept: { tag: string; client: ServiceClient } | undefined;
    /** The service in use, its calls, and a tag for what's kept for it. */
    const current = () => {
      const active = options.active();
      if (!active) return undefined;
      const tag = `${active.service}\n${active.key}`;
      if (kept?.tag !== tag) kept = { tag, client: makeClient(active.service, active.key) };
      return { ...active, ...kept };
    };

    const [changed, setChanged] = createSignal(0);
    const states = new Map<string, { state: CacheState; until: number }>();
    const asking = new Set<string>();
    const links = new Map<string, { resolved: Resolved; until: number }>();
    const resolving = new Map<string, Promise<Resolved>>();

    const keepState = (key: string, state: CacheState, ms = DEBRID_KEPT_MS) => {
      states.delete(key);
      states.set(key, { state, until: now() + ms });
      for (const old of states.keys()) {
        if (states.size <= STATES_KEPT) break;
        states.delete(old);
      }
    };
    const stateFor = (tag: string, hash: string) => {
      const key = `${tag}\n${hash}`;
      const had = states.get(key);
      if (had && had.until > now()) return had.state;
      return undefined;
    };

    /** What's known of a torrent at the service in use; "checking" until it's asked. */
    const stateOf = (hash: string): CacheState => {
      changed();
      const active = current();
      if (!active) return "unknown";
      const known = stateFor(active.tag, hash);
      if (known) return known;
      return serviceInfo(active.service).checks ? "checking" : "unknown";
    };

    /** Asks the service which of these torrents it has, if it can say, of those not known. */
    const check = async (hashes: string[]) => {
      const active = current();
      if (!active?.client.check) return;
      const { tag } = active;
      const wanted = hashes.filter(
        (hash, at) => hashes.indexOf(hash) === at && !stateFor(tag, hash) && !asking.has(`${tag}\n${hash}`),
      );
      if (wanted.length === 0) return;
      wanted.forEach(hash => asking.add(`${tag}\n${hash}`));
      try {
        const found = await active.client.check(wanted);
        wanted.forEach(hash => keepState(`${tag}\n${hash}`, found.has(hash) ? "cached" : "notCached"));
      } catch (error) {
        console.warn(`${serviceInfo(active.service).name} couldn't check its torrents:`, error);
        // Played, they're found to be there or not.
        wanted.forEach(hash => keepState(`${tag}\n${hash}`, "unknown", FAILED_KEPT_MS));
      } finally {
        wanted.forEach(hash => asking.delete(`${tag}\n${hash}`));
        setChanged(n => n + 1);
      }
    };

    /** The torrent's link at the service in use; throws a DebridFailure. */
    const resolve = (wanted: Wanted): Promise<Resolved> => {
      const active = current();
      if (!active) return Promise.reject(failure("key", "No debrid service is set"));
      const { torrent } = wanted;
      const key = [
        active.tag,
        torrent.infoHash,
        torrent.fileIdx ?? "",
        wanted.filename ?? "",
        torrent.season ?? "",
        torrent.episode ?? "",
      ].join("\n");
      const had = links.get(key);
      if (had && had.until > now()) return Promise.resolve(had.resolved);
      const pending = resolving.get(key);
      if (pending) return pending;
      const asked = active.client
        .resolve(wanted)
        .then(resolved => {
          links.delete(key);
          links.set(key, { resolved, until: now() + DEBRID_KEPT_MS });
          for (const old of links.keys()) {
            if (links.size <= LINKS_KEPT) break;
            links.delete(old);
          }
          keepState(`${active.tag}\n${torrent.infoHash}`, "cached");
          setChanged(n => n + 1);
          return resolved;
        })
        .catch((error: unknown) => {
          if (failKind(error) === "notCached") {
            keepState(`${active.tag}\n${torrent.infoHash}`, "notCached");
            setChanged(n => n + 1);
          }
          throw error;
        })
        .finally(() => resolving.delete(key));
      resolving.set(key, asked);
      return asked;
    };

    return {
      /** The service torrents play through, if one is set. */
      service: () => options.active()?.service,
      stateOf,
      check,
      resolve,
      /** Forgets what's known, as after signing in again. */
      forget: () => {
        states.clear();
        links.clear();
        setChanged(n => n + 1);
      },
    };
  });

export type Debrid = ReturnType<typeof createDebrid>;
