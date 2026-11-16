import { describe, expect, it } from "vitest";
import { createNuvioFake, type NuvioFakeOptions } from "../../scripts/test-streams/nuvio";
import { pollPairing, readTime, startPairing, tvName, waitForOwner } from "./pairing";

const BASE = "http://test.local";
const SITE = "http://sync.test";

const setup = (options: Partial<NuvioFakeOptions> = {}) => {
  const clock = { now: 1_000_000 };
  const fake = createNuvioFake({ base: BASE, site: SITE, now: () => clock.now, ...options });
  const fetcher: typeof fetch = (input, init) => fake.fetch(new Request(input, init));
  return { clock, fake, fetcher, now: () => clock.now };
};

const noWait = () => Promise.resolve();
const notOne: typeof fetch = () => Promise.resolve(new Response("<html>", { status: 404 }));
const offline: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
const limited: typeof fetch = () => Promise.resolve(new Response("{}", { status: 429 }));
const busy: typeof fetch = () => Promise.resolve(new Response("{}", { status: 503 }));

describe("signing in a TV", () => {
  it("shows a QR address and a code to type for the same sign-in", async () => {
    const { fake, fetcher, now } = setup();
    const pairing = await startPairing(SITE, "Living room TV", fetcher, now);
    expect(pairing.userCode).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(pairing.url).toBe(`${SITE}/link?code=${pairing.userCode}`);
    expect(pairing.page).toBe(`${SITE}/link`);
    expect(pairing.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(pairing.pollMs).toBe(3_000);
    expect(pairing.lifetime).toBe(5 * 60_000);
    expect(fake.summary().logins).toEqual([
      { name: "Living room TV", userCode: pairing.userCode, status: "pending" },
    ]);
  });

  it("signs in by the typed code, in any case, or the QR address", async () => {
    for (const typed of [(code: string) => code.toLowerCase(), (_code: string, url: string) => url]) {
      const { fake, fetcher, now } = setup();
      const pairing = await startPairing(SITE, "TV", fetcher, now);
      const run = waitForOwner(pairing, fetcher, now, noWait);
      expect(fake.approve(typed(pairing.userCode ?? "", pairing.url))).toEqual({ name: "TV" });
      const step = await run.done;
      expect(step).toMatchObject({
        status: "done",
        server: { site: SITE, backend: SITE },
        session: { expiresAt: now() + 3_600_000 },
      });
      expect(fake.summary().tvsSignedIn).toBe(1);
      // Used once only.
      expect(await pollPairing(pairing, fetcher, now)).toEqual({ status: "expired" });
    }
  });

  it("refuses a code that doesn't work", async () => {
    const { fake, fetcher, now } = setup();
    await startPairing(SITE, "TV", fetcher, now);
    expect(() => fake.approve("ZZZZZZ")).toThrow("This code doesn't work");
  });

  it("signs nothing in without the TV's nonce", async () => {
    const { fake, fetcher, now } = setup();
    const pairing = await startPairing(SITE, "TV", fetcher, now);
    fake.approve(pairing.userCode ?? "");
    expect(await pollPairing({ ...pairing, nonce: "0".repeat(32) }, fetcher, now)).toEqual({
      status: "expired",
    });
    expect(await pollPairing(pairing, fetcher, now)).toMatchObject({ status: "done" });
  });

  it("has only the QR code on a server without the typed one", async () => {
    const { fake, fetcher, now } = setup({ qrOnly: true });
    const pairing = await startPairing(SITE, "TV", fetcher, now);
    expect(pairing.userCode).toBeUndefined();
    expect(pairing.page).toBeUndefined();
    expect(pairing.url).toBe(`${SITE}/tv-login?code=${pairing.code}`);
    const run = waitForOwner(pairing, fetcher, now, noWait);
    fake.approve(pairing.url);
    expect(await run.done).toMatchObject({ status: "done" });
  });

  it("gives up when the code's time is over", async () => {
    const { clock, fetcher, now } = setup();
    const pairing = await startPairing(SITE, "TV", fetcher, now);
    const waits: number[] = [];
    const run = waitForOwner(pairing, fetcher, now, ms => {
      waits.push(ms);
      clock.now += 60_000;
      return Promise.resolve();
    });
    expect(await run.done).toEqual({ status: "expired" });
    expect(waits.every(ms => ms === pairing.pollMs)).toBe(true);
    expect(waits.length).toBe(5);
  });

  it("is refused past the account's TV limit", async () => {
    const { fake, fetcher, now } = setup({ tvLimit: 0 });
    const pairing = await startPairing(SITE, "TV", fetcher, now);
    const run = waitForOwner(pairing, fetcher, now, noWait);
    fake.approve(pairing.userCode ?? "");
    expect(await run.done).toEqual({
      status: "failed",
      problem: "This account is signed in on 0 TVs, its limit",
    });
  });

  it("keeps waiting through a busy or unreachable server, and stops when asked", async () => {
    const { fetcher, now } = setup();
    const pairing = await startPairing(SITE, "TV", fetcher, now);
    for (const fetching of [busy, limited, offline])
      expect(await pollPairing(pairing, fetching, now)).toEqual({ status: "waiting" });
    let polls = 0;
    const run = waitForOwner(
      pairing,
      () => {
        polls++;
        return Promise.reject(new TypeError("Failed to fetch"));
      },
      now,
      noWait,
    );
    await Promise.resolve();
    run.stop();
    expect(await run.done).toBeUndefined();
    expect(polls).toBeLessThan(5);
  });

  it("says why a site isn't a server", async () => {
    await expect(startPairing(SITE, "TV", notOne)).rejects.toThrow(`${SITE} isn't a Velio or Nuvio server`);
  });

  it("times the code by the server's clock", async () => {
    const date = new Date("2026-11-16T12:00:00Z");
    const answers: Record<string, unknown> = {
      "/.well-known/nuvio": { publishable_key: "key" },
      "/rest/v1/rpc/start_device_login_session": [
        {
          device_code: "abc",
          user_code: "K7QM2X",
          verification_uri: `${SITE}/link`,
          verification_uri_complete: `${SITE}/link?code=K7QM2X`,
          expires_at: "2026-11-16 12:10:00.123456+00",
          poll_interval_seconds: 1,
        },
      ],
    };
    const fetcher: typeof fetch = input => {
      const path = new URL(new Request(input).url).pathname;
      return Promise.resolve(Response.json(answers[path], { headers: { Date: date.toUTCString() } }));
    };
    const pairing = await startPairing(SITE, "TV", fetcher, () => 5);
    expect(pairing.lifetime).toBe(10 * 60_000 + 123);
    expect(pairing.startedAt).toBe(5);
    // Never more often than every 3 seconds.
    expect(pairing.pollMs).toBe(3_000);
  });
});

describe("the TV's details", () => {
  it("reads PostgREST's times, to the millisecond", () => {
    expect(readTime("2026-11-16 12:00:00.123456+00:00")).toBe(Date.UTC(2026, 10, 16, 12, 0, 0, 123));
    expect(readTime("2026-11-16 12:00:00.5+00")).toBe(Date.UTC(2026, 10, 16, 12, 0, 0, 500));
    expect(readTime("2026-11-16T12:00:00Z")).toBe(Date.UTC(2026, 10, 16, 12));
    expect(readTime(5)).toBeNaN();
  });

  it("names a TV it doesn't know as Velio TV", () => {
    expect(tvName()).toBe("Velio TV");
  });
});
