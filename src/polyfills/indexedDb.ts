// getAll() and getAllKeys() on object stores and indexes, and
// openKeyCursor() on object stores, which Chromium has had since 48; the
// oldest TVs supported have 38 (webOS 3) and 47 (Tizen 3). Each reads with a cursor and answers through a request-like
// object, as the app's code only listens for its success and error events
// and reads `result` and `error` (db.ts, request()). Modules that use those
// methods call ensureGetAll() first; it does nothing where they exist.

type Source = IDBObjectStore | IDBIndex;
type Query = IDBValidKey | IDBKeyRange | null | undefined;
type Listener = (event: Event) => void;

/** A cursor over keys: a key cursor where there is one, else one that reads values too. */
export const keyCursor = (source: Source, query?: Query) =>
  typeof source.openKeyCursor === "function"
    ? source.openKeyCursor(query ?? null)
    : source.openCursor(query ?? null);

/** Reads with a cursor what getAll (values) or getAllKeys (keys) would. */
export const readAll = <T>(source: Source, what: "values" | "keys", query?: Query, count?: number) => {
  const listeners: Record<string, Listener[]> = { success: [], error: [] };
  const found: T[] = [];
  const fake = {
    result: undefined as T[] | undefined,
    error: null as DOMException | null,
    readyState: "pending" as IDBRequestReadyState,
    source,
    onsuccess: null as Listener | null,
    onerror: null as Listener | null,
    addEventListener: (type: string, listener: Listener) => listeners[type]?.push(listener),
    removeEventListener: (type: string, listener: Listener) => {
      const list = listeners[type];
      if (list?.includes(listener)) list.splice(list.indexOf(listener), 1);
    },
  };
  // With the cursor's own event: Chromium 38's workers can't make one.
  const fire = (type: "success" | "error", event: Event) => {
    fake.readyState = "done";
    const handler = type === "success" ? fake.onsuccess : fake.onerror;
    handler?.(event);
    for (const listener of listeners[type].slice()) listener(event);
  };
  const cursor = what === "values" ? source.openCursor(query ?? null) : keyCursor(source, query);
  cursor.addEventListener("success", event => {
    const at = cursor.result;
    if (at && (count === undefined || count === 0 || found.length < count)) {
      const value: unknown = what === "values" && "value" in at ? at.value : at.primaryKey;
      // Stored values are whatever was put; callers name their type, as with getAll.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      found.push(value as T);
      at.continue();
      return;
    }
    fake.result = found;
    fire("success", event);
  });
  cursor.addEventListener("error", event => {
    fake.error = cursor.error;
    fire("error", event);
  });
  // It has what the app reads of a request.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return fake as unknown as IDBRequest<T[]>;
};

const install = (prototype: Source) => {
  if (typeof prototype.getAll !== "function") {
    prototype.getAll = function (this: Source, query?: Query, count?: number) {
      return readAll<unknown>(this, "values", query, count);
    };
  }
  if (typeof prototype.getAllKeys !== "function") {
    prototype.getAllKeys = function (this: Source, query?: Query, count?: number) {
      return readAll<IDBValidKey>(this, "keys", query, count);
    };
  }
};

/** Adds getAll() and getAllKeys() where the browser lacks them. */
export const ensureGetAll = () => {
  if (typeof IDBObjectStore !== "undefined") install(IDBObjectStore.prototype);
  if (typeof IDBIndex !== "undefined") install(IDBIndex.prototype);
};
