import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import type { DeviceProfile, DeviceView } from "../sync-core/device";
import { createProfiles, PROFILE_KEY, profileKey, profileStorage } from "./profiles";

class MemoryStorage implements Storage {
  items = new Map<string, string>();
  [name: string]: unknown;
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const profile = (id: string, pin?: string): DeviceProfile => ({ id, name: id, color: 0, lists: [], pin });
const view = (rev: number, ...profiles: DeviceProfile[]): DeviceView => ({ rev, profiles, lists: [] });

const setup = (storage = new MemoryStorage()) => {
  const [list, setList] = createSignal<DeviceProfile[]>([]);
  const profiles = createProfiles({ storage, profiles: list });
  return { storage, profiles, setList };
};

describe("profiles on the TV", () => {
  it("keeps per-profile keys apart, and the rest shared", () => {
    const base = new MemoryStorage();
    let current: string | undefined = "a";
    const storage = profileStorage(base, () => current);
    storage.setItem("velio.watched", "A's");
    storage.setItem("velio.settings", "the TV's");
    current = "b";
    expect(storage.getItem("velio.watched")).toBeNull();
    expect(storage.getItem("velio.settings")).toBe("the TV's");
    current = undefined;
    storage.setItem("velio.watched", "no profile");
    expect(base.getItem("velio.watched@a")).toBe("A's");
    expect(base.getItem("velio.watched")).toBe("no profile");
    expect(profileKey("velio.lastChannel", "b")).toBe("velio.lastChannel@b");
  });

  it("has none, and asks for none, while signed out", () => {
    const { profiles } = setup();
    expect(profiles.current()).toBeUndefined();
    expect(profiles.needsPick()).toBe(false);
  });

  it("asks which profile when there are several, and remembers the choice", () => {
    const { profiles, setList, storage } = setup();
    setList([profile("a"), profile("b")]);
    expect(profiles.needsPick()).toBe(true);
    expect(profiles.choose("b")).toBe(true);
    expect(profiles.currentId()).toBe("b");
    expect(profiles.needsPick()).toBe(false);
    expect(storage.getItem(PROFILE_KEY)).toBe("b");
    expect(profiles.choose("nobody")).toBe(false);

    const again = setup(storage);
    again.setList([profile("a"), profile("b")]);
    expect(again.profiles.currentId()).toBe("b");
  });

  it("chooses the only profile by itself, unless it has a PIN", () => {
    const { profiles, setList } = setup();
    setList([profile("a", "1234")]);
    expect(profiles.needsPick()).toBe(true);
    expect(profiles.chooseOnly()).toBe(false);
    setList([profile("a")]);
    expect(profiles.needsPick()).toBe(false);
    expect(profiles.chooseOnly()).toBe(true);
    expect(profiles.currentId()).toBe("a");
  });

  it("gives the TV's data so far to the first profile at the first pull", () => {
    const { profiles, storage } = setup();
    storage.setItem("velio.channelEdits", "edits");
    storage.setItem("velio.watched", "watched");
    storage.setItem("velio.watched@a", "kept");
    profiles.viewChanged(view(1, profile("a"), profile("b")), undefined);
    expect(storage.getItem("velio.channelEdits@a")).toBe("edits");
    expect(storage.getItem("velio.watched@a")).toBe("kept");
    expect(storage.getItem("velio.channelEdits@b")).toBeNull();
    // The TV's own stay, for when it signs out.
    expect(storage.getItem("velio.channelEdits")).toBe("edits");
  });

  it("deletes a profile taken from the TV, and asks again if it was in use", () => {
    const { profiles, setList, storage } = setup();
    const before = view(1, profile("a"), profile("b"));
    setList(before.profiles);
    profiles.choose("b");
    storage.setItem("velio.watched@b", "b's");
    storage.setItem("velio.watched@a", "a's");
    const after = view(2, profile("a"));
    setList(after.profiles);
    profiles.viewChanged(after, before);
    expect(storage.getItem("velio.watched@b")).toBeNull();
    expect(storage.getItem("velio.watched@a")).toBe("a's");
    expect(profiles.currentId()).toBeUndefined();
    expect(storage.getItem(PROFILE_KEY)).toBeNull();
    expect(profiles.needsPick()).toBe(false);
  });

  it("deletes every profile's data when the TV signs out", () => {
    const { profiles, setList, storage } = setup();
    const last = view(1, profile("a"), profile("b"));
    setList(last.profiles);
    profiles.choose("a");
    storage.setItem("velio.reminders@a", "x");
    storage.setItem("velio.lastChannel@b", "y");
    storage.setItem("velio.reminders", "the TV's");
    setList([]);
    profiles.signedOut(last);
    expect([...storage.items.keys()]).toEqual(["velio.reminders"]);
  });
});
