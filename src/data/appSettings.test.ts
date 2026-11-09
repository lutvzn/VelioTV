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
    settings.setLanguage("pt-BR");
    settings.setHoldSpeed("guide", 40);
    expect(createAppSettings({ storage }).all()).toEqual({
      startOn: "guide",
      clock: "12h",
      language: "pt-BR",
      holdSpeeds: { groups: 20, guide: 40, posters: 20 },
    });
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
    expect(
      readSettings({
        startOn: "guide",
        clock: "1h",
        pin: "12345",
        language: "fr",
        holdSpeeds: { groups: 10, guide: 7, posters: "60" },
      }),
    ).toEqual({
      startOn: "guide",
      clock: "24h",
      language: "auto",
      holdSpeeds: { groups: 10, guide: 20, posters: 20 },
    });
    expect(readSettings({ language: "pt-BR" }).language).toBe("pt-BR");
    expect(readSettings(null)).toEqual(defaultSettings());
  });
});
