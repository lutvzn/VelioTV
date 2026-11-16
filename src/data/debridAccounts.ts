// The profile's debrid accounts (src/debrid/services.ts): a key for each
// service signed in to, and the one torrents play through. Kept as one
// record in the profile's storage (src/data/profiles.ts), which backups
// and the account don't send, so the keys stay on the TV.

import { createMemo, createRoot, createSignal } from "solid-js";
import { SERVICE_IDS, type ServiceId } from "../debrid/services";

export interface DebridAccounts {
  /** The service torrents play through; none plays no torrents. */
  service?: ServiceId;
  keys: Partial<Record<ServiceId, string>>;
}

export const DEBRID_KEY = "velio.debrid";
const NONE: DebridAccounts = { keys: {} };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const serviceOf = (value: unknown) => SERVICE_IDS.find(id => id === value);

/** The kept record, without unknown services, empty keys or a service with no key. */
export const readDebridAccounts = (text: string | null): DebridAccounts => {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "{}");
  } catch {
    value = {};
  }
  if (!isObject(value)) return NONE;
  const keys: Partial<Record<ServiceId, string>> = {};
  if (isObject(value.keys))
    for (const id of SERVICE_IDS) {
      const key = value.keys[id];
      if (typeof key === "string" && key.trim()) keys[id] = key.trim().slice(0, 500);
    }
  const service = serviceOf(value.service);
  return service && keys[service] ? { service, keys } : { keys };
};

export const createDebridAccounts = (options: {
  storage: Pick<Storage, "getItem" | "setItem">;
  profile: () => string | undefined;
}) =>
  createRoot(() => {
    const [saved, setSaved] = createSignal(0);
    const accounts = createMemo(() => {
      options.profile();
      saved();
      try {
        return readDebridAccounts(options.storage.getItem(DEBRID_KEY));
      } catch {
        return NONE;
      }
    });
    const keep = (next: DebridAccounts) => {
      try {
        options.storage.setItem(DEBRID_KEY, JSON.stringify(next));
      } catch (error) {
        console.warn("Couldn't keep the debrid accounts:", error);
      }
      setSaved(n => n + 1);
    };
    /** The service in use and its key, if one is set. */
    const active = createMemo(() => {
      const { service, keys } = accounts();
      const key = service ? keys[service] : undefined;
      return service && key ? { service, key } : undefined;
    });
    return {
      accounts,
      active,
      /** Keeps a service's key, or forgets it when empty; the first key kept is the one in use. */
      setKey: (id: ServiceId, key: string) => {
        const now = accounts();
        const keys = { ...now.keys };
        const trimmed = key.trim();
        if (trimmed) keys[id] = trimmed;
        else delete keys[id];
        const service = now.service && keys[now.service] ? now.service : trimmed ? id : undefined;
        keep(service ? { service, keys } : { keys });
      },
      /** The service torrents play through, or none. */
      use: (id: ServiceId | undefined) => {
        const now = accounts();
        keep(id && now.keys[id] ? { service: id, keys: now.keys } : { keys: now.keys });
      },
    };
  });

export type DebridAccountsStore = ReturnType<typeof createDebridAccounts>;
