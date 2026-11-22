import { describe, expect, it } from "vitest";
import { discover, NUVIO_SITE, type Server } from "./nuvio";

const nuvio: Server = { site: NUVIO_SITE, backend: "https://backend.example", key: "pk" };
const noFetch: typeof fetch = () => Promise.reject(new Error("no request expected"));

describe("discover", () => {
  it("uses the build's address for Nuvio's own server, without asking it", async () => {
    await expect(discover(NUVIO_SITE, noFetch, nuvio)).resolves.toEqual(nuvio);
  });

  it("says so when the build has no address for Nuvio", async () => {
    await expect(discover(NUVIO_SITE, noFetch, undefined)).rejects.toThrow("Nuvio's server address");
  });

  it("reads any other site's discovery document", async () => {
    const asked: string[] = [];
    const fetcher: typeof fetch = input => {
      asked.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(
        new Response(JSON.stringify({ backend_url: "https://api.example/", publishable_key: "k" })),
      );
    };
    await expect(discover("https://velio.example", fetcher, nuvio)).resolves.toEqual({
      site: "https://velio.example",
      backend: "https://api.example",
      key: "k",
    });
    expect(asked).toEqual(["https://velio.example/.well-known/nuvio"]);
  });
});
