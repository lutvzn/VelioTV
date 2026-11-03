// Phase 2 step 1: how fast IndexedDB stores and reads guide data on the TV,
// for several storage layouts. A Web Worker writes the same synthetic guide
// (random words, so storage compression can't flatter it) in each layout,
// then reads it back the way the guide screens would.
//
// Input (all optional):
//   "channels": 200, "days": 7, "perDay": 24   the size of the guide
//   "batch": 2000   programmes per write transaction
//   "layouts": ["programme", ...]   which layouts to run, from LAYOUTS below
//
// Each layout uses its own database, deleted afterwards.

// A worker's postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin

async function probe(input) {
  // Runs in the worker. It's turned into source text, so it may only use
  // what's defined inside it.
  const worker = () => {
    const DAY = 86400000;
    // Each layout: how records are stored, and whether transactions ask for
    // relaxed durability (the browser may skip flushing each one to disk).
    const LAYOUTS = {
      // One record per programme, with an index on channel and start time.
      programme: { records: "programme", relaxed: false },
      programmeRelaxed: { records: "programme", relaxed: true },
      // One record per programme, keyed by channel and start time, so
      // there's no separate index to update.
      programmeKey: { records: "programmeKey", relaxed: false },
      // One record per channel per day, holding that day's programmes.
      channelDay: { records: "channelDay", relaxed: false },
      channelDayRelaxed: { records: "channelDay", relaxed: true },
      // As channelDay, without descriptions, which would be stored
      // separately and read only when a programme is opened.
      channelDayNoDescription: { records: "channelDayNoDescription", relaxed: false },
    };

    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const SYLLABLES = ["ka", "lo", "mi", "ne", "ru", "sa", "to", "vi", "ze", "an", "or", "el", "us", "ip"];
    const word = () =>
      Array.from({ length: 2 + Math.floor(random() * 3) }, () => SYLLABLES[Math.floor(random() * 14)]).join(
        "",
      );
    const words = count => Array.from({ length: count }, word).join(" ");

    // Programmes for one channel and day, as the parser would produce them.
    const DAY0 = Date.UTC(2026, 10, 2);
    const schedule = (channel, day, perDay) => {
      const length = DAY / perDay;
      return Array.from({ length: perDay }, (_, i) => ({
        channel,
        start: DAY0 + day * DAY + i * length,
        stop: DAY0 + day * DAY + (i + 1) * length,
        title: words(3),
        description: words(30),
      }));
    };

    const request = r =>
      new Promise((resolve, reject) => {
        r.addEventListener("success", () => resolve(r.result));
        r.addEventListener("error", () => reject(r.error));
      });
    const open = (name, records) => {
      const r = indexedDB.open(name, 1);
      r.addEventListener("upgradeneeded", () => {
        const db = r.result;
        if (records === "programme") {
          db.createObjectStore("guide", { autoIncrement: true }).createIndex("channelStart", [
            "channel",
            "start",
          ]);
        } else if (records === "programmeKey") {
          db.createObjectStore("guide", { keyPath: ["channel", "start"] });
        } else {
          db.createObjectStore("guide", { keyPath: ["channel", "day"] });
        }
      });
      return request(r);
    };
    const transaction = (db, mode, relaxed) =>
      relaxed ? db.transaction("guide", mode, { durability: "relaxed" }) : db.transaction("guide", mode);
    const finished = t =>
      new Promise((resolve, reject) => {
        t.addEventListener("complete", resolve);
        t.addEventListener("error", () => reject(t.error));
        t.addEventListener("abort", () => reject(t.error));
      });

    // A guide row: one channel's programmes between two times.
    const readRow = async (db, records, channel, from, to) => {
      const store = transaction(db, "readonly").objectStore("guide");
      const showing = p => p.stop > from && p.start < to;
      if (records === "programme" || records === "programmeKey") {
        // Starting up to 6 hours earlier, to catch a programme already
        // running at the left edge.
        const range = IDBKeyRange.bound([channel, from - 6 * 3600000], [channel, to], false, true);
        const source = records === "programme" ? store.index("channelStart") : store;
        return (await request(source.getAll(range))).filter(showing);
      }
      const days = await request(
        store.getAll(
          IDBKeyRange.bound(
            [channel, Math.floor((from - DAY0) / DAY)],
            [channel, Math.floor((to - DAY0) / DAY)],
          ),
        ),
      );
      return days.flatMap(day => day.programmes).filter(showing);
    };

    const usage = async () =>
      navigator.storage?.estimate
        ? Math.round((await navigator.storage.estimate()).usage / 1048576)
        : undefined;

    const run = async (name, options) => {
      const { channels, days, perDay, batch } = options;
      const layout = LAYOUTS[name];
      const dbName = `tv-probe-storage-${name}`;
      await request(indexedDB.deleteDatabase(dbName));
      const usageBefore = await usage();
      const db = await open(dbName, layout.records);
      seed = 1;

      let writeMs = 0;
      let pending = [];
      let pendingProgrammes = 0;
      const flush = async () => {
        const started = performance.now();
        const t = transaction(db, "readwrite", layout.relaxed);
        const store = t.objectStore("guide");
        for (const record of pending) store.put(record);
        await finished(t);
        writeMs += performance.now() - started;
        pending = [];
        pendingProgrammes = 0;
      };

      const total = channels * days * perDay;
      for (let channel = 0; channel < channels; channel++) {
        const id = `channel-${channel}.example`;
        for (let day = 0; day < days; day++) {
          const programmes = schedule(id, day, perDay);
          if (layout.records === "channelDay") pending.push({ channel: id, day, programmes });
          else if (layout.records === "channelDayNoDescription") {
            pending.push({
              channel: id,
              day,
              programmes: programmes.map(({ description: _, ...rest }) => rest),
            });
          } else pending.push(...programmes);
          pendingProgrammes += programmes.length;
          if (pendingProgrammes >= batch) await flush();
        }
      }
      if (pending.length > 0) await flush();

      // Reads, timed: one channel's whole week, and a guide screen of 10
      // channels by 3 hours, at 20 different places.
      let started = performance.now();
      const week = await readRow(db, layout.records, "channel-7.example", DAY0, DAY0 + days * DAY);
      const weekMs = performance.now() - started;
      started = performance.now();
      let shown = 0;
      for (let screen = 0; screen < 20; screen++) {
        const first = (screen * 37) % Math.max(1, channels - 10);
        const from = DAY0 + ((screen * 5) % (days * 24 - 3)) * 3600000;
        const rows = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            readRow(db, layout.records, `channel-${first + i}.example`, from, from + 3 * 3600000),
          ),
        );
        shown += rows.reduce((sum, row) => sum + row.length, 0);
      }
      const screenMs = (performance.now() - started) / 20;

      const usageAfter = await usage();
      db.close();
      await request(indexedDB.deleteDatabase(dbName));
      return {
        programmes: total,
        writeSeconds: Math.round(writeMs) / 1000,
        programmesPerSecond: Math.round(total / (writeMs / 1000)),
        weekRead: { programmes: week.length, ms: Math.round(weekMs) },
        screenRead: { programmes: Math.round(shown / 20), ms: Math.round(screenMs * 10) / 10 },
        storedMb: usageBefore === undefined ? "not available" : usageAfter - usageBefore,
      };
    };

    self.addEventListener("message", async ({ data }) => {
      try {
        const options = {
          channels: data.channels ?? 200,
          days: data.days ?? 7,
          perDay: data.perDay ?? 24,
          batch: data.batch ?? 2000,
        };
        const results = {};
        for (const name of data.layouts ?? Object.keys(LAYOUTS)) {
          self.postMessage({ progress: `${name}...` });
          results[name] = await run(name, options);
          self.postMessage({ progress: `${name}: ${results[name].programmesPerSecond} programmes/s` });
        }
        self.postMessage({ done: { options, results } });
      } catch (error) {
        self.postMessage({ error: `${error.name}: ${error.message}` });
      }
    });
  };

  const log = (...args) => console.log("[probe]", ...args);

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
      if (data.progress) log(data.progress);
      else resolve(data);
    });
    thread.addEventListener("error", event => resolve({ error: `worker error: ${event.message}` }));
    thread.postMessage(input);
  });
  running = false;
  thread.terminate();

  return {
    ...outcome,
    mainThreadFps: {
      average: Math.round(fps.reduce((a, b) => a + b, 0) / fps.length),
      lowest: Math.min(...fps),
    },
  };
}
