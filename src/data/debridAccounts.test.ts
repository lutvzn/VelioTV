import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createDebridAccounts, DEBRID_KEY, readDebridAccounts } from "./debridAccounts";
import { memoryStorage } from "./memoryStorage";

describe("the debrid accounts", () => {
  it("use the first key kept, and none once it's removed", () => {
    const accounts = createDebridAccounts({ storage: memoryStorage(), profile: () => "p" });
    expect(accounts.active()).toBeUndefined();
    accounts.setKey("realdebrid", " RD ");
    accounts.setKey("torbox", "TB");
    expect(accounts.active()).toEqual({ service: "realdebrid", key: "RD" });
    accounts.use("torbox");
    expect(accounts.active()).toEqual({ service: "torbox", key: "TB" });
    accounts.setKey("torbox", "");
    expect(accounts.active()).toBeUndefined();
    expect(accounts.accounts().keys).toEqual({ realdebrid: "RD" });
    accounts.use("offcloud");
    expect(accounts.active()).toBeUndefined();
  });

  it("read each profile's own record", () => {
    const storage = memoryStorage();
    const [profile, setProfile] = createSignal("one");
    const accounts = createDebridAccounts({ storage, profile });
    accounts.setKey("torbox", "TB");
    storage.setItem(DEBRID_KEY, "{}");
    setProfile("two");
    expect(accounts.active()).toBeUndefined();
  });

  it("drop what it doesn't know", () => {
    expect(readDebridAccounts("{oops")).toEqual({ keys: {} });
    expect(
      readDebridAccounts(
        JSON.stringify({ service: "torbox", keys: { torbox: " ", pikpak: "x", premiumize: "P" } }),
      ),
    ).toEqual({
      keys: { premiumize: "P" },
    });
  });
});
