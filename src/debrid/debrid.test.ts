import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { failure, type Resolved, type ServiceClient, type Wanted } from "./api";
import { type Active, createDebrid, DEBRID_KEPT_MS } from "./debrid";

const A = "a".repeat(40);
const B = "b".repeat(40);
const wanted = (infoHash: string): Wanted => ({ torrent: { infoHash, sources: [] } });

/** A service that has only A, counting what it's asked. */
const fakeService = (checks = true) => {
  const asked = { check: [] as string[][], resolve: 0 };
  const client: ServiceClient = {
    ...(checks
      ? {
          check: async (hashes: string[]) => {
            asked.check.push(hashes);
            return new Set(hashes.filter(hash => hash === A));
          },
        }
      : {}),
    resolve: async (want): Promise<Resolved> => {
      asked.resolve++;
      await Promise.resolve();
      if (want.torrent.infoHash !== A) throw failure("notCached", "not there");
      return { url: "https://cdn.example.invalid/a.mkv" };
    },
    account: async () => undefined,
  };
  return { client, asked };
};

describe("the debrid service in use", () => {
  it("know which torrents it has, asking each once", async () => {
    const service = fakeService();
    const debrid = createDebrid({
      active: () => ({ service: "torbox", key: "K" }),
      client: () => service.client,
    });
    expect(debrid.stateOf(A)).toBe("checking");
    await debrid.check([A, B, A]);
    await debrid.check([A, B]);
    expect(service.asked.check).toEqual([[A, B]]);
    expect(debrid.stateOf(A)).toBe("cached");
    expect(debrid.stateOf(B)).toBe("notCached");
  });

  it("not say for a service that can't check, until a torrent is played", async () => {
    const service = fakeService(false);
    const debrid = createDebrid({
      active: () => ({ service: "realdebrid", key: "K" }),
      client: () => service.client,
    });
    expect(debrid.stateOf(B)).toBe("unknown");
    await expect(debrid.resolve(wanted(B))).rejects.toThrow("not there");
    expect(debrid.stateOf(B)).toBe("notCached");
  });

  it("ask a link once at a time, and keep it for a while", async () => {
    let time = 0;
    const service = fakeService();
    const debrid = createDebrid({
      active: () => ({ service: "torbox", key: "K" }),
      client: () => service.client,
      now: () => time,
    });
    const [one, two] = await Promise.all([debrid.resolve(wanted(A)), debrid.resolve(wanted(A))]);
    expect(one).toBe(two);
    await debrid.resolve(wanted(A));
    expect(service.asked.resolve).toBe(1);
    time += DEBRID_KEPT_MS + 1;
    await debrid.resolve(wanted(A));
    expect(service.asked.resolve).toBe(2);
  });

  it("start again for another key, and play nothing without one", async () => {
    const [active, setActive] = createSignal<Active | undefined>({ service: "torbox", key: "K" });
    const made: string[] = [];
    const debrid = createDebrid({
      active,
      client: (id, key) => {
        made.push(`${id} ${key}`);
        return fakeService().client;
      },
    });
    await debrid.check([A]);
    setActive({ service: "torbox", key: "L" });
    expect(debrid.stateOf(A)).toBe("checking");
    await debrid.check([A]);
    expect(made).toEqual(["torbox K", "torbox L"]);
    setActive(undefined);
    expect(debrid.service()).toBeUndefined();
    expect(debrid.stateOf(A)).toBe("unknown");
    await expect(debrid.resolve(wanted(A))).rejects.toThrow("No debrid service is set");
  });
});
