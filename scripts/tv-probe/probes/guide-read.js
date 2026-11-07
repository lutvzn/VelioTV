// Phase 4, step 1: compares reading guide screens on the main thread, as the
// app did in Phase 3 (db.readGuide), with reading them in the guide worker
// (src/data/guideClient.ts). Meanwhile it records the main thread's frames,
// to see how much each blocks the UI.
//
// It uses the guide of a source the app already has, with channels that
// aren't read twice, so IndexedDB and the worker's own cache start cold for
// each pass. Run it with the app on any page; playing video is fine.
// The worker leaves out subtitles and descriptions, and reads them for one
// programme at a time, as the guide does when a programme is focused; it
// times that too (PLAN.md, Phase 8, step 2).
//
// Input (all optional):
//   "rows": 10          channels in a guide screen
//   "passes": 3         screens read each way, taking turns
//   "scrollRows": 40    rows read one at a time, as when scrolling down
//   "scrollEveryMs": 100   how often a new row is read while scrolling

async function probe(input) {
  const log = (...args) => console.log("[probe]", ...args);
  const app = window.tiviplayer;
  if (!app?.createGuideClient)
    return { error: "window.tiviplayer has no createGuideClient: deploy a newer build" };
  const { rows = 10, passes = 3, scrollRows = 40, scrollEveryMs = 100 } = input;
  const DAY = app.db.DAY;
  const HOUR = 3600000;

  // The app has just restarted: wait for it to read its channel lists.
  for (let waited = 0; waited < 30000 && app.lineup.channels().length === 0; waited += 200) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const channels = app.lineup.channels().filter(c => c.guideId);
  const needed = 2 * (rows * passes + scrollRows) + 2;
  if (channels.length < needed) {
    return { error: `need ${needed} channels with a guide, the app has ${channels.length}` };
  }
  // Each read takes the next unused channels; keep away from the start,
  // which the app may have read for its own pages.
  let nextChannel = Math.floor(channels.length / 4);
  const take = n => {
    const picked = [];
    for (let i = 0; i < n; i++) picked.push(channels[nextChannel++ % channels.length]);
    return picked;
  };

  // The main thread's frames: the gap between animation frames.
  let frames = [];
  let last = performance.now();
  let running = true;
  requestAnimationFrame(function frame(now) {
    frames.push(now - last);
    last = now;
    if (running) requestAnimationFrame(frame);
  });
  const idle = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Runs `work`, returning its time and the frames drawn meanwhile.
  const measure = async work => {
    await idle(300);
    frames = [];
    const started = performance.now();
    const value = await work();
    const ms = performance.now() - started;
    await idle(100);
    const gaps = frames;
    return {
      value,
      ms: Math.round(ms),
      longestFrameMs: Math.round(Math.max(0, ...gaps)),
      framesOver50ms: gaps.filter(g => g > 50).length,
    };
  };

  const now = Date.now();
  const today = Math.floor(now / DAY);
  const db = await app.db.openDb();
  const client = app.createGuideClient();

  // A guide screen: `rows` channels over the 3 hours from now.
  const mainScreen = list =>
    Promise.all(list.map(c => app.db.readGuide(db, c.source, c.guideId, now, now + 3 * HOUR)));
  // In the worker, a screen is the day it falls in (and the next, near midnight).
  const days = [today];
  if (Math.floor((now + 3 * HOUR) / DAY) > today) days.push(today + 1);
  const workerScreen = list =>
    Promise.all(list.flatMap(c => days.map(d => client.read(c.source, c.guideId, d))));
  const count = lists => lists.reduce((n, list) => n + list.length, 0);

  // Both ways give the same programmes, but for the details.
  const check = take(2);
  const gridOf = ({ subTitle: _s, description: _d, ...grid }) => grid;
  const fromMain = (await mainScreen(check)).map(list => list.map(gridOf));
  const fromWorker = await workerScreen(check);
  // Near midnight (UTC), a programme over it is in both days.
  const inScreen = list =>
    list.filter((p, i) => p.stop > now && p.start < now + 3 * HOUR && list[i - 1]?.start !== p.start);
  const same = check.every(
    (c, i) =>
      JSON.stringify(fromMain[i]) ===
      JSON.stringify(inScreen(fromWorker.slice(i * days.length, (i + 1) * days.length).flat())),
  );
  log("same programmes both ways:", same);

  const screens = { main: [], worker: [] };
  for (let pass = 0; pass < passes; pass++) {
    const main = await measure(() => mainScreen(take(rows)));
    screens.main.push({ ...main, programmes: count(main.value), value: undefined });
    const before = { ...client.stats };
    const worker = await measure(() => workerScreen(take(rows)));
    screens.worker.push({
      ...worker,
      programmes: count(worker.value),
      value: undefined,
      inWorker: {
        getMs: Math.round(client.stats.getMs - before.getMs),
        decodeMs: Math.round(client.stats.decodeMs - before.decodeMs),
        records: client.stats.decoded - before.decoded,
      },
    });
    log(
      `pass ${pass + 1}: main ${main.ms} ms (frame ${main.longestFrameMs}), worker ${worker.ms} ms (frame ${worker.longestFrameMs})`,
    );
  }

  // Scrolling: a new row every `scrollEveryMs`, without waiting for the last.
  const scroll = read => async () => {
    const list = take(scrollRows);
    const latencies = [];
    const reads = [];
    for (const channel of list) {
      const started = performance.now();
      reads.push(read(channel).then(() => latencies.push(performance.now() - started)));
      await idle(scrollEveryMs);
    }
    await Promise.all(reads);
    latencies.sort((a, b) => a - b);
    return {
      medianMs: Math.round(latencies[Math.floor(latencies.length / 2)]),
      maxMs: Math.round(latencies.at(-1)),
    };
  };
  const scrolling = {};
  const ways = { main: c => mainScreen([c]), worker: c => workerScreen([c]) };
  for (const name of ["main", "worker"]) {
    const read = ways[name];
    const result = await measure(scroll(read));
    const gaps = frames;
    const seconds = gaps.reduce((a, b) => a + b, 0) / 1000;
    scrolling[name] = {
      rowLatency: result.value,
      fps: Math.round(gaps.length / seconds),
      longestFrameMs: result.longestFrameMs,
      framesOver50ms: result.framesOver50ms,
    };
    log(`scroll ${name}:`, JSON.stringify(scrolling[name]));
  }

  // The details of the programme on now, for channels in turn: the first of
  // a block unpacks it whole, the next ones in it are kept.
  const details = [];
  for (const channel of take(10)) {
    const programme = (await client.read(channel.source, channel.guideId, today)).find(
      p => p.start <= now && p.stop > now,
    );
    if (!programme) continue;
    const started = performance.now();
    const found = await client.details(channel.source, channel.guideId, programme.start);
    details.push({ ms: Math.round(performance.now() - started), description: Boolean(found.description) });
  }
  log("details:", JSON.stringify(details));

  running = false;
  client.close();
  db.close();

  const summary = list => ({
    ms: list.map(s => s.ms),
    longestFrameMs: list.map(s => s.longestFrameMs),
    programmes: list.map(s => s.programmes),
    ...(list[0]?.inWorker ? { inWorker: list.map(s => s.inWorker) } : {}),
  });
  return {
    channels: channels.length,
    rows,
    same,
    screens: { main: summary(screens.main), worker: summary(screens.worker) },
    scrolling,
    detailsMs: details.map(d => d.ms),
    withDescription: details.filter(d => d.description).length,
    freeMemoryMb: Math.round(tizen.systeminfo.getAvailableMemory() / 1048576),
  };
}
