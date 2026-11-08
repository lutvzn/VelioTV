import { describe, expect, it } from "vitest";
import { SimpleController } from "./abort";
import { simpleFetch } from "./fetch";

const blobUrl = (parts: BlobPart[], type = "text/plain") => URL.createObjectURL(new Blob(parts, { type }));

describe("fetch over XMLHttpRequest", () => {
  it("answers with the status, headers and text", async () => {
    const response = await simpleFetch(blobUrl(["hello ", "there"]));
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(await response.text()).toBe("hello there");
    await expect(response.text()).rejects.toThrow("already been read");
  });

  it("reads JSON", async () => {
    const response = await simpleFetch(new URL(blobUrl([JSON.stringify({ a: [1, 2] })])));
    expect(await response.json()).toEqual({ a: [1, 2] });
  });

  it("gives the body out in pieces, with every byte", async () => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const response = await simpleFetch(blobUrl([bytes], "application/octet-stream"));
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    const pieces: Uint8Array[] = [];
    for (let read = await reader.read(); !read.done; read = await reader.read()) pieces.push(read.value);
    expect(pieces.map(piece => piece.length)).toEqual([65_536, 65_536, 65_536, 3392]);
    const joined = new Uint8Array(bytes.length);
    let at = 0;
    for (const piece of pieces) {
      joined.set(piece, at);
      at += piece.length;
    }
    expect(joined).toEqual(bytes);
  });

  it("fails as fetch does when the request can't be made", async () => {
    await expect(simpleFetch("http://127.0.0.1:1/nothing")).rejects.toThrow("Failed to fetch");
  });

  it("stops when its signal aborts", async () => {
    const controller = new SimpleController();
    controller.abort();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the app's own signal stands in
    const signal = controller.signal as unknown as AbortSignal;
    await expect(simpleFetch(blobUrl(["x"]), { signal })).rejects.toMatchObject({ name: "AbortError" });
    const native = new AbortController();
    const pending = simpleFetch("http://127.0.0.1:1/nothing", { signal: native.signal });
    native.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
