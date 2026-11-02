// Phase 0 test 6: parsing large XMLTV guides on the TV. Streams each file
// into a Web Worker, as Phase 2 would, and parses it piece by piece without
// building an XML document. Meanwhile the main thread records its frame rate
// and the TV's free memory, to see whether the UI would stay smooth.
//
// Input:
//   "sources": [{ "url": "...", "gzip": true }]   parsed in order, as one guide;
//       "gzip" means the file itself is gzipped, so the worker decompresses it
//   "store": "programmes"   save to IndexedDB instead of keeping it in memory,
//       one record per programme, indexed by channel and start time
//   "store": "grouped"   save one record per channel per batch, holding that
//       channel's programmes in the batch, indexed by channel
//   (The database is deleted afterwards.)

// A worker's postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin

async function probe(input) {
  // Runs in the worker. It's turned into source text, so it may only use
  // what's defined inside it.
  const worker = () => {
    const DB_NAME = "tv-probe-guide";
    const BATCH = 2000;

    const decode = text =>
      text
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&amp;", "&");
    const attribute = (tag, name) => {
      const match = tag.match(new RegExp(` ${name}="([^"]*)"`));
      return match ? decode(match[1]) : undefined;
    };
    const element = (block, name) => {
      const match = block.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
      return match ? decode(match[1]) : undefined;
    };
    // "20261102194600 +0000" to milliseconds since 1970.
    const time = value => {
      const [, y, mo, d, h, mi, s, sign, oh, om] = value.match(
        /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-])?(\d\d)?(\d\d)?/,
      );
      const offset = sign ? (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60000 : 0;
      return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offset;
    };

    const openDb = () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.addEventListener("upgradeneeded", () => {
          const db = request.result;
          db.createObjectStore("channels", { keyPath: "id" });
          db.createObjectStore("programmes", { autoIncrement: true }).createIndex("channelStart", [
            "channel",
            "start",
          ]);
          db.createObjectStore("schedules", { autoIncrement: true }).createIndex("channel", "channel");
        });
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
    const write = (db, store, items) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(store, "readwrite");
        const objects = transaction.objectStore(store);
        for (const item of items) objects.put(item);
        transaction.addEventListener("complete", resolve);
        transaction.addEventListener("error", () => reject(transaction.error));
      });

    self.addEventListener("message", async ({ data }) => {
      try {
        const started = performance.now();
        const db = data.store ? await openDb() : undefined;
        const kept = { channels: [], programmes: [] };
        let writeMs = 0;
        const flush = async (store, items) => {
          if (!db) {
            for (const item of items) kept[store].push(item);
            return;
          }
          let target = store;
          let records = items;
          if (store === "programmes" && data.store === "grouped") {
            const byChannel = new Map();
            for (const item of items) {
              if (!byChannel.has(item.channel)) byChannel.set(item.channel, []);
              byChannel.get(item.channel).push(item);
            }
            target = "schedules";
            records = [...byChannel].map(([channel, programmes]) => ({
              channel,
              start: programmes[0].start,
              programmes,
            }));
          }
          const writeStarted = performance.now();
          await write(db, target, records);
          writeMs += performance.now() - writeStarted;
        };

        const sources = [];
        for (const source of data.sources) {
          const result = { url: source.url, downloadedBytes: 0, chars: 0, channels: 0, programmes: 0 };
          const sourceStarted = performance.now();
          const response = await fetch(source.url);
          let body = response.body.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                result.downloadedBytes += chunk.length;
                controller.enqueue(chunk);
              },
            }),
          );
          if (source.gzip) body = body.pipeThrough(new DecompressionStream("gzip"));
          const reader = body.pipeThrough(new TextDecoderStream()).getReader();

          let buffer = "";
          let nextReport = 8 * 1048576;
          let channels = [];
          let programmes = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            result.chars += value.length;
            if (result.chars >= nextReport) {
              const seconds = Math.round(performance.now() - sourceStarted) / 1000;
              self.postMessage({
                parsing: `${Math.round(result.chars / 1048576)} MB parsed in ${seconds} s`,
              });
              nextReport += 8 * 1048576;
            }
            buffer += value;
            let position = 0;
            // Where the next of each element starts, or -1 for none in the
            // buffer. Searching again only once they're passed keeps this
            // linear: a guide's channels all come first, so searching for the
            // next channel at every programme would rescan the whole buffer.
            let channelAt = buffer.indexOf("<channel ");
            let programmeAt = buffer.indexOf("<programme ");
            for (;;) {
              if (channelAt !== -1 && channelAt < position) channelAt = buffer.indexOf("<channel ", position);
              if (programmeAt !== -1 && programmeAt < position) {
                programmeAt = buffer.indexOf("<programme ", position);
              }
              const isChannel = channelAt !== -1 && (programmeAt === -1 || channelAt < programmeAt);
              const start = isChannel ? channelAt : programmeAt;
              if (start === -1) break;
              const closing = isChannel ? "</channel>" : "</programme>";
              const end = buffer.indexOf(closing, start);
              if (end === -1) {
                position = start;
                break;
              }
              const block = buffer.slice(start, end + closing.length);
              const tag = block.slice(0, block.indexOf(">") + 1);
              if (isChannel) {
                channels.push({
                  id: attribute(tag, "id"),
                  name: element(block, "display-name"),
                  icon: attribute(block, "src"),
                });
              } else {
                programmes.push({
                  channel: attribute(tag, "channel"),
                  start: time(attribute(tag, "start")),
                  stop: time(attribute(tag, "stop")),
                  title: element(block, "title"),
                  description: element(block, "desc"),
                });
              }
              position = end + closing.length;
            }
            buffer = buffer.slice(position);
            if (channels.length >= BATCH) {
              result.channels += channels.length;
              await flush("channels", channels);
              channels = [];
            }
            if (programmes.length >= BATCH) {
              result.programmes += programmes.length;
              await flush("programmes", programmes);
              programmes = [];
            }
          }
          result.channels += channels.length;
          result.programmes += programmes.length;
          await flush("channels", channels);
          await flush("programmes", programmes);
          result.seconds = Math.round(performance.now() - sourceStarted) / 1000;
          sources.push(result);
          self.postMessage({ progress: result });
        }

        const summary = {
          totalSeconds: Math.round(performance.now() - started) / 1000,
          writeSeconds: Math.round(writeMs) / 1000,
          sources,
          keptInMemory: db ? 0 : kept.programmes.length,
          workerHeapMb: performance.memory
            ? Math.round(performance.memory.usedJSHeapSize / 1048576)
            : "not available",
        };
        if (db) {
          db.close();
          await new Promise(resolve => {
            const request = indexedDB.deleteDatabase(DB_NAME);
            request.addEventListener("success", resolve);
            request.addEventListener("error", resolve);
          });
        }
        self.postMessage({ done: summary });
      } catch (error) {
        self.postMessage({ error: `${error.name}: ${error.message}` });
      }
    });
  };

  const log = (...args) => console.log("[probe]", ...args);
  const support = {
    decompressionStream: typeof DecompressionStream !== "undefined",
    textDecoderStream: typeof TextDecoderStream !== "undefined",
  };

  // The TV's free memory, sampled every second.
  const memory = [];
  const sampleMemory = () => memory.push(Math.round(tizen.systeminfo.getAvailableMemory() / 1048576));
  sampleMemory();
  const memoryTimer = setInterval(sampleMemory, 1000);

  // The main thread's frame rate, per second, while the worker runs.
  const fps = [];
  let frames = 0;
  let since = performance.now();
  let running = true;
  requestAnimationFrame(function count(now) {
    frames++;
    if (now - since >= 1000) {
      fps.push(Math.round((frames * 1000) / (now - since)));
      frames = 0;
      since = now;
    }
    if (running) requestAnimationFrame(count);
  });

  const source = `(${worker.toString()})();`;
  const thread = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
  const outcome = await new Promise(resolve => {
    thread.addEventListener("message", ({ data }) => {
      if (data.parsing) log(data.parsing);
      else if (data.progress) {
        const p = data.progress;
        log(`${p.url.split("/").slice(-2).join("/")}: ${p.programmes} programmes in ${p.seconds} s`);
      } else resolve(data);
    });
    thread.addEventListener("error", event => resolve({ error: `worker error: ${event.message}` }));
    thread.postMessage(input);
  });
  running = false;
  clearInterval(memoryTimer);
  thread.terminate();

  return {
    support,
    ...outcome,
    freeMemoryMb: { before: memory[0], lowest: Math.min(...memory), after: memory.at(-1) },
    mainThreadFps: {
      average: Math.round(fps.reduce((a, b) => a + b, 0) / fps.length),
      lowest: Math.min(...fps),
    },
  };
}
