import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyCursor, readAll } from "./indexedDb";

const DB = "tiviplayer-polyfill-test";

const request = <T>(r: IDBRequest) =>
  new Promise<T>((resolve, reject) => {
    r.addEventListener("success", () => resolve(r.result));
    r.addEventListener("error", () => reject(r.error ?? new Error("failed")));
  });

describe("getAll and getAllKeys without the browser's own", () => {
  let db: IDBDatabase;

  beforeAll(async () => {
    await request(indexedDB.deleteDatabase(DB));
    const open = indexedDB.open(DB, 1);
    open.addEventListener("upgradeneeded", () => {
      const store = open.result.createObjectStore("items", { keyPath: ["group", "n"] });
      store.createIndex("byName", "name");
    });
    db = await request<IDBDatabase>(open);
    const store = db.transaction("items", "readwrite").objectStore("items");
    for (let n = 0; n < 10; n++) store.put({ group: n < 5 ? "a" : "b", n, name: `item ${9 - n}` });
    await new Promise(resolve => store.transaction.addEventListener("complete", resolve));
  });

  afterAll(() => db.close());

  const both = async (read: (store: IDBObjectStore) => [IDBRequest, IDBRequest]) => {
    const store = db.transaction("items").objectStore("items");
    const [native, shim] = read(store);
    return Promise.all([request<unknown[]>(native), request<unknown[]>(shim)]);
  };

  it("reads what getAll and getAllKeys do, with a range and a count", async () => {
    const range = IDBKeyRange.bound(["a", 2], ["b", 7]);
    const pairs = [
      await both(store => [store.getAll(), readAll(store, "values")]),
      await both(store => [store.getAllKeys(), readAll(store, "keys")]),
      await both(store => [store.getAll(range), readAll(store, "values", range)]),
      await both(store => [store.getAll(range, 3), readAll(store, "values", range, 3)]),
      await both(store => [store.getAllKeys(range, 2), readAll(store, "keys", range, 2)]),
    ];
    for (const [native, shim] of pairs) expect(shim).toEqual(native);
    expect(pairs[0][1]).toHaveLength(10);
    expect(pairs[3][1]).toHaveLength(3);
  });

  it("reads an index, keys being the records' keys", async () => {
    const [native, shim] = await both(store => {
      const index = store.index("byName");
      return [index.getAllKeys(), readAll(index, "keys")];
    });
    expect(shim).toEqual(native);
    expect(shim[0]).toEqual(["b", 9]);
  });

  // The keys of group "b", read with keyCursor.
  const keysOfB = async () => {
    const found: IDBValidKey[] = [];
    const cursor = keyCursor(db.transaction("items").objectStore("items"), IDBKeyRange.lowerBound(["b"]));
    await new Promise<void>(resolve => {
      cursor.addEventListener("success", () => {
        if (!cursor.result) return resolve();
        found.push(cursor.result.primaryKey);
        cursor.result.continue();
      });
    });
    return found;
  };

  it("walks keys where object stores have no key cursor", async () => {
    const native = await keysOfB();
    const own = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "openKeyCursor");
    Reflect.deleteProperty(IDBObjectStore.prototype, "openKeyCursor");
    try {
      expect(await keysOfB()).toEqual(native);
    } finally {
      if (own) Object.defineProperty(IDBObjectStore.prototype, "openKeyCursor", own);
    }
    expect(native).toHaveLength(5);
  });

  it("lets the transaction go on after it", async () => {
    const store = db.transaction("items", "readwrite").objectStore("items");
    const all = await request<unknown[]>(readAll(store, "values"));
    await request(store.put({ group: "c", n: all.length, name: "after" }));
    expect(await request(store.count())).toBe(11);
  });
});
