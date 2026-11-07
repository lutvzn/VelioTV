import { describe, expect, it } from "vitest";
import { createAppSettings, defaultSettings, readSettings } from "./appSettings";
import { memoryStorage } from "./memoryStorage";

describe("app settings", () => {
  it("keep the start page and clock across a restart", () => {
    const storage = memoryStorage();
    const settings = createAppSettings({ storage });
    expect(settings.all()).toEqual(defaultSettings());
    settings.setStartOn("guide");
    settings.setClock("12h");
    expect(createAppSettings({ storage }).all()).toEqual({ startOn: "guide", clock: "12h" });
  });

  it("hold locked channels open once the PIN is entered, until a restart", () => {
    const storage = memoryStorage();
    const settings = createAppSettings({ storage });
    expect(settings.unlocked()).toBe(true);
    expect(settings.setPin("12a4")).toBe(false);
    expect(settings.setPin("1234")).toBe(true);
    expect(settings.unlocked()).toBe(true);

    const again = createAppSettings({ storage });
    expect(again.hasPin()).toBe(true);
    expect(again.unlocked()).toBe(false);
    expect(again.checkPin("4321")).toBe(false);
    expect(again.unlocked()).toBe(false);
    expect(again.checkPin("1234")).toBe(true);
    expect(again.unlocked()).toBe(true);
    again.lock();
    expect(again.unlocked()).toBe(false);
    again.setPin(undefined);
    expect(again.unlocked()).toBe(true);
    expect(createAppSettings({ storage }).hasPin()).toBe(false);
  });

  it("read restored settings, leaving out what doesn't fit", () => {
    expect(readSettings({ startOn: "guide", clock: "1h", pin: "12345" })).toEqual({
      startOn: "guide",
      clock: "24h",
    });
    expect(readSettings(null)).toEqual(defaultSettings());
  });
});
