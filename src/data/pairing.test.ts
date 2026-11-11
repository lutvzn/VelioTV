import { describe, expect, it } from "vitest";
import { createSyncMock, type SyncMock } from "../../scripts/test-streams/sync";
import { readPairingCode } from "../sync-core/pairing";
import { pollPairing, startPairing, tvName, waitForOwner } from "./pairing";

const SITE = "http://sync.test";
const fetcherFor =
  (mock: SyncMock): typeof fetch =>
  (input, init) =>
    mock.fetch(new Request(input, init));

const refusing: typeof fetch = () =>
  Promise.resolve(
    new Response(JSON.stringify({ problem: "Too many tries. Wait a minute." }), { status: 429 }),
  );

describe("signing in a TV", () => {
  it("shows a QR address and a typed code for the same pairing", async () => {
    const mock = createSyncMock({ base: "http://test.local" });
    const pairing = await startPairing(SITE, "Living room TV", fetcherFor(mock));
    expect(pairing.url.startsWith(`${SITE}/pair#${pairing.id}.`)).toBe(true);
    expect(pairing.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(readPairingCode(pairing.url)).toMatchObject({ id: pairing.id, kind: "qr" });
    expect(readPairingCode(pairing.code)).toMatchObject({ id: pairing.id, kind: "code" });
    expect(mock.summary().waiting).toEqual([{ id: pairing.id, name: "Living room TV" }]);
  });

  it("signs in by the QR address too", async () => {
    const mock = createSyncMock({ base: "http://test.local" });
    const fetcher = fetcherFor(mock);
    const pairing = await startPairing(SITE, "TV", fetcher);
    const run = waitForOwner(pairing, fetcher);
    const { device } = mock.approve(pairing.url, ["Guest"]);
    const step = await run.done;
    expect(step).toMatchObject({ status: "done", trust: { account: "test-account", device } });
    // Picked up once only.
    expect(await pollPairing(pairing, fetcher)).toEqual({ status: "expired" });
  });

  it("refuses a code with the wrong secret", async () => {
    const mock = createSyncMock({ base: "http://test.local" });
    const pairing = await startPairing(SITE, "TV", fetcherFor(mock));
    const wrong = pairing.code.slice(0, 5) + (pairing.code[5] === "0" ? "1" : "0") + pairing.code.slice(6);
    expect(() => mock.approve(wrong)).toThrow("Wrong code");
  });

  it("gives up when the pairing's 10 minutes are over", async () => {
    let clock = 1_000_000;
    const mock = createSyncMock({ base: "http://test.local", now: () => clock });
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(new Request(input).url);
      // The server answers at once, as if its 20 s wait had passed.
      if (url.pathname.startsWith("/v1/pair/")) url.searchParams.set("wait", "0");
      return mock.fetch(new Request(url, init));
    };
    const pairing = await startPairing(SITE, "TV", fetcher, () => clock);
    const waits: number[] = [];
    const run = waitForOwner(
      pairing,
      fetcher,
      () => clock,
      ms => {
        waits.push(ms);
        clock += 60_000;
        return Promise.resolve();
      },
    );
    expect(await run.done).toEqual({ status: "expired" });
    // Each quick answer waited, so it asked about once a minute here, never in a burst.
    expect(waits.length).toBeGreaterThan(5);
    expect(waits.every(ms => ms > 0 && ms <= 3000)).toBe(true);
  });

  it("stops when asked", async () => {
    const mock = createSyncMock({ base: "http://test.local" });
    const fetcher = fetcherFor(mock);
    const pairing = await startPairing(SITE, "TV", fetcher);
    const run = waitForOwner(pairing, fetcher);
    run.stop();
    mock.approve(pairing.code);
    expect(await run.done).toBeUndefined();
  });

  it("says why the server refused", async () => {
    await expect(startPairing(SITE, "TV", refusing)).rejects.toThrow("Too many tries. Wait a minute.");
  });

  it("names the TV in at most 40 characters", () => {
    expect(tvName().length).toBeLessThanOrEqual(40);
    expect(tvName()).not.toBe("");
  });
});
