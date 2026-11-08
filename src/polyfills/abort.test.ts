import { describe, expect, it } from "vitest";
import { abortError, isAbortError, SimpleController } from "./abort";

describe("AbortController for the oldest TVs", () => {
  it("aborts once, telling onabort and the listeners", () => {
    const controller = new SimpleController();
    const heard: string[] = [];
    const listener = () => heard.push("listener");
    controller.signal.addEventListener("abort", listener);
    controller.signal.addEventListener("abort", () => heard.push("removed"));
    controller.signal.removeEventListener("abort", listener);
    controller.signal.addEventListener("abort", listener);
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(heard).toEqual(["removed", "listener"]);
    expect(isAbortError(controller.signal.reason)).toBe(true);
    expect(() => controller.signal.throwIfAborted()).toThrow("signal is aborted");
  });

  it("makes and knows an AbortError", () => {
    expect(isAbortError(abortError("stop"))).toBe(true);
    expect(isAbortError(new Error("other"))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
