import { describe, expect, it } from "vitest";
import {
  openSettingsFor,
  setSettingsCategory,
  settingsActionPending,
  settingsCategory,
  takeSettingsAction,
} from "./category";

describe("openSettingsFor", () => {
  it("shows the action's category, and gives the action once, to that category", () => {
    setSettingsCategory("about");
    openSettingsFor("signIn");
    expect(settingsCategory()).toBe("account");
    expect(settingsActionPending()).toBe(true);
    // Another category's page doesn't take it.
    expect(takeSettingsAction("sources")).toBeUndefined();
    expect(takeSettingsAction("account")).toBe("signIn");
    expect(takeSettingsAction("account")).toBeUndefined();
    expect(settingsActionPending()).toBe(false);

    openSettingsFor("addSource");
    expect(settingsCategory()).toBe("sources");
    expect(takeSettingsAction("sources")).toBe("addSource");
    expect(settingsActionPending()).toBe(false);
  });
});
