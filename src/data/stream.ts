// Reads a download as text, piece by piece.

import { Gunzip } from "fflate";

type Bytes = Uint8Array<ArrayBuffer>;

const isGzip = (bytes: Bytes) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

// A download's pieces, counting each as it arrives.
async function* pieces(reader: ReadableStreamDefaultReader<Bytes>, onBytes?: (bytes: number) => void) {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onBytes?.(value.length);
    yield value;
  }
}

// Decompresses with the browser's DecompressionStream.
async function* nativeGunzip(source: AsyncGenerator<Bytes>): AsyncGenerator<Uint8Array> {
  const compressed = new ReadableStream<BufferSource>({
    async pull(controller) {
      const next = await source.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: async () => {
      await source.return(undefined);
    },
  });
  const reader = compressed.pipeThrough(new DecompressionStream("gzip")).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Decompresses with fflate, for TVs whose browsers lack DecompressionStream.
async function* fflateGunzip(source: AsyncGenerator<Bytes>): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = [];
  const gunzip = new Gunzip();
  gunzip.ondata = data => out.push(data);
  for await (const piece of source) {
    gunzip.push(piece);
    yield* out.splice(0);
  }
  gunzip.push(new Uint8Array(0), true);
  yield* out.splice(0);
}

/**
 * Yields a byte stream's text as it arrives, decompressing it first if it is
 * gzipped (whatever the URL or Content-Type say). `onBytes` gets the size of
 * each piece downloaded, before decompressing, to show progress against
 * Content-Length. `native: false` forces fflate's gunzip, for tests.
 */
export async function* readText(
  body: ReadableStream<Bytes>,
  onBytes?: (bytes: number) => void,
  { native = typeof DecompressionStream !== "undefined" } = {},
): AsyncGenerator<string> {
  const reader = body.getReader();
  const downloaded = pieces(reader, onBytes);
  try {
    const first = await downloaded.next();
    if (first.done) return;
    // Puts the first piece back in front of the rest.
    const all = async function* () {
      yield first.value;
      yield* downloaded;
    };
    let source: AsyncGenerator<Uint8Array> = all();
    if (isGzip(first.value)) source = native ? nativeGunzip(all()) : fflateGunzip(all());

    // TextDecoder with { stream: true } rather than TextDecoderStream, which
    // older TVs lack.
    const decoder = new TextDecoder();
    for await (const piece of source) {
      const text = decoder.decode(piece, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    // Stops the download if the reader gives up early.
    await reader.cancel().catch(() => {});
  }
}
