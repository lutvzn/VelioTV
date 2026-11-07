import { describe, expect, it } from "vitest";
import { watchLifecycle } from "./lifecycle";

describe("the app's lifecycle", () => {
  it("suspends while hidden and follows the network", () => {
    const calls: string[] = [];
    const player = {
      suspend: () => void calls.push("suspend"),
      resume: () => void calls.push("resume"),
      setOnline: (online: boolean) => void calls.push(online ? "online" : "offline"),
    };
    let visibility: DocumentVisibilityState = "visible";
    const page = new EventTarget();
    Object.defineProperty(page, "visibilityState", { get: () => visibility });
    const net = Object.assign(new EventTarget(), { navigator: { onLine: false } });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const stop = watchLifecycle(player, page as Document, net as unknown as Window);
    expect(calls).toEqual(["offline"]);

    visibility = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    net.dispatchEvent(new Event("online"));
    net.dispatchEvent(new Event("offline"));
    expect(calls).toEqual(["offline", "suspend", "resume", "online", "offline"]);

    stop();
    page.dispatchEvent(new Event("visibilitychange"));
    net.dispatchEvent(new Event("online"));
    expect(calls).toHaveLength(5);
  });
});
