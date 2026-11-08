import { afterEach, describe, expect, it } from "vitest";
import { memoryStorage } from "./memoryStorage";
import { createSettingsCopy, STAMP_KEY } from "./settingsCopy";

let count = 0;
const names: string[] = [];
const freshName = () => {
  const name = `settings-copy-test-${Date.now()}-${count++}`;
  names.push(name);
  return name;
};

afterEach(async () => {
  for (const name of names.splice(0)) {
    await new Promise(resolve => {
      const r = indexedDB.deleteDatabase(name);
      for (const event of ["success", "error", "blocked"]) r.addEventListener(event, resolve);
    });
  }
});

// The app's start: a new copy over the same database, with localStorage as it reads then.
const start = (local: Storage, name: string) => createSettingsCopy(local, name);

describe("the settings copy", () => {
  it("starts a copy from what localStorage holds, and keeps it level", async () => {
    const name = freshName();
    const local = memoryStorage();
    local.setItem("velio.sources", "[1]");
    local.setItem("other", "not ours");
    const first = start(local, name);
    expect((await first.restore()).action).toBe("seeded");
    first.storage.setItem("velio.settings", "{}");
    await first.flushed();

    const again = start(local, name);
    expect((await again.restore()).action).toBe("same");
  });

  it("puts the settings back when localStorage reads as empty", async () => {
    const name = freshName();
    const local = memoryStorage();
    const first = start(local, name);
    await first.restore();
    first.storage.setItem("velio.sources", "[1,2]");
    first.storage.setItem("velio.edits", "{}");
    await first.flushed();

    const empty = memoryStorage();
    const result = await start(empty, name).restore();
    expect(result.action).toBe("restored");
    expect(result.keys).toBe(2);
    expect(empty.getItem("velio.sources")).toBe("[1,2]");
    expect(empty.getItem("velio.edits")).toBe("{}");
  });

  it("puts back the newer settings over old ones, removals too", async () => {
    const name = freshName();
    const local = memoryStorage();
    const first = start(local, name);
    await first.restore();
    first.storage.setItem("velio.sources", "[1]");
    first.storage.setItem("velio.removedSources", '["a"]');
    await first.flushed();
    // localStorage as it was then, without what came after.
    const old = memoryStorage();
    for (const key of ["velio.sources", "velio.removedSources", STAMP_KEY]) {
      old.setItem(key, local.getItem(key) ?? "");
    }
    await new Promise(resolve => setTimeout(resolve, 2));
    first.storage.setItem("velio.sources", "[1,2]");
    first.storage.removeItem("velio.removedSources");
    await first.flushed();

    expect((await start(old, name).restore()).action).toBe("restored");
    expect(old.getItem("velio.sources")).toBe("[1,2]");
    expect(old.getItem("velio.removedSources")).toBeNull();
    expect(old.getItem(STAMP_KEY)).toBe(local.getItem(STAMP_KEY));
  });

  it("follows localStorage when the copy missed writes", async () => {
    const name = freshName();
    const local = memoryStorage();
    const first = start(local, name);
    await first.restore();
    first.storage.setItem("velio.sources", "[1]");
    await first.flushed();
    // A write the copy never got.
    local.setItem("velio.sources", "[1,2,3]");
    local.setItem(STAMP_KEY, String(Number(local.getItem(STAMP_KEY)) + 10));

    expect((await start(local, name).restore()).action).toBe("recopied");
    const empty = memoryStorage();
    expect((await start(empty, name).restore()).action).toBe("restored");
    expect(empty.getItem("velio.sources")).toBe("[1,2,3]");
  });

  it("leaves out keys that aren't the app's, or are probes' own", async () => {
    const name = freshName();
    const local = memoryStorage();
    const first = start(local, name);
    await first.restore();
    first.storage.setItem("velio.probe.kill", "1");
    first.storage.setItem("someone.else", "1");
    first.storage.setItem("velio.settings", "{}");
    await first.flushed();

    const empty = memoryStorage();
    expect((await start(empty, name).restore()).keys).toBe(1);
    expect(empty.getItem("velio.probe.kill")).toBeNull();
    expect(empty.getItem("someone.else")).toBeNull();
  });
});
