import { describe, expect, it } from "vitest";
import { errorText } from "./status";

describe("import errors", () => {
  it("are told in the app's words where the app knows them", () => {
    expect(errorText("http://example.test/list.m3u: HTTP 404")).toBe("The server answered with error 404.");
    expect(errorText("TypeError: Failed to fetch")).toBe("Couldn't reach the server.");
    expect(errorText("Xtream login failed: wrong username or password, or the account has ended")).toBe(
      "Wrong username or password, or the account has ended.",
    );
    expect(errorText("Xtream account is Banned")).toBe("The account is Banned.");
    expect(errorText("QuotaExceededError: (no message) (while storing the guide)")).toBe(
      "The TV's storage for the app is full.",
    );
  });

  it("are shown as written otherwise", () => {
    expect(errorText("Something new")).toBe("Something new");
  });
});
