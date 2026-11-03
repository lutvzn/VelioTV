// Whether the Tizen filesystem API can hold what IndexedDB can't (its quota
// is 80 MB per app; see the quota probe). Writes random bytes to a file in
// the app's private folder (wgt-private) in 1 MB pieces, timing the writes
// and the main thread's frame rate, reads part back, then deletes the file.
// Also checks whether the API exists inside a Web Worker.
//
// Needs the filesystem.read and filesystem.write privileges in config.xml.
//
// Input (all optional):
//   "mb": 200   how much to write

async function probe(input) {
  const MB = 1048576;
  const total = input.mb ?? 200;
  const path = "wgt-private/tv-probe-files.bin";
  const log = (...args) => console.log("[probe]", ...args);

  const inWorker = await new Promise(resolve => {
    const source = "postMessage(typeof tizen !== 'undefined' && !!tizen.filesystem)";
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    worker.addEventListener("message", event => {
      worker.terminate();
      resolve(event.data);
    });
    worker.addEventListener("error", event => resolve(`error: ${event.message}`));
  });

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
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

  const result = { inWorker };
  try {
    const bytes = new Uint8Array(MB);
    for (let i = 0; i < MB; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
    const file = tizen.filesystem.openFile(path, "w");
    let slowest = 0;
    const started = performance.now();
    for (let written = 0; written < total; written++) {
      const t = performance.now();
      file.writeData(bytes);
      slowest = Math.max(slowest, performance.now() - t);
      // One piece per frame, as an import on the main thread would.
      await nextFrame();
      if ((written + 1) % 50 === 0) log(`${written + 1} MB written`);
    }
    file.close();
    result.write = {
      mb: total,
      seconds: Math.round(performance.now() - started) / 1000,
      slowestWriteMs: Math.round(slowest),
    };

    const reader = tizen.filesystem.openFile(path, "r");
    let t = performance.now();
    reader.seek(Math.floor(total / 2) * MB + 12345);
    const piece = reader.readData(16384);
    result.readOffsetMs = Math.round((performance.now() - t) * 10) / 10;
    result.readMatches = piece[0] === bytes[12345] && piece[100] === bytes[12445];
    t = performance.now();
    reader.seek(0);
    reader.readData(MB);
    result.readMbMs = Math.round(performance.now() - t);
    reader.close();
  } catch (error) {
    result.error = `${error.name}: ${error.message}`;
  }
  try {
    tizen.filesystem.deleteFile(path);
  } catch (error) {
    result.deleteError = `${error.name}: ${error.message}`;
  }
  running = false;
  result.mainThreadFps = {
    average: Math.round(fps.reduce((a, b) => a + b, 0) / fps.length),
    lowest: Math.min(...fps),
  };
  return result;
}
