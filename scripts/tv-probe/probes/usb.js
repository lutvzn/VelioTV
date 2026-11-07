// Phase 7, step 4: whether the app can record to a USB drive. It looks for a
// mounted USB drive (plug one in first; the app needs the filesystem
// privileges in devices/tizen/config.xml), writes a live test stream to a
// file on it as it arrives, for "seconds", then plays the file back. About
// 20 s plus "seconds". The file is deleted at the end unless "keep" is set.
//
// It reports the drives it found, the stream's and the writes' rates, the
// longest single write (writes block the page, so a long one stalls the
// UI), whether the page kept drawing meanwhile, and whether the file plays.
//
// Input:
//   "server": "http://<dev-ip>:8090"   the test server (required)
//   "seconds": 60                      how long to record
//   "stream": "h264-aac"               the test stream's name
//   "wait": 0                          seconds to wait for a drive to be plugged in
//   "keep": false                      leave the file on the drive
//   "drive": "wgt-private-tmp"         another storage instead, by its label, to try the
//                                      writes without a drive (mind the app's 80 MB)

async function probe(input) {
  const app = window.tiviplayer;
  if (!input.server) return { error: 'Give the test server\'s address as "server"' };
  if (typeof tizen === "undefined" || !tizen.filesystem) return { error: "No tizen.filesystem" };
  const { player } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const error = caught => `${caught?.name ?? ""}: ${caught?.message ?? caught}`;
  const fs = tizen.filesystem;

  const storages = () =>
    new Promise(resolve => {
      try {
        fs.listStorages(resolve, caught => resolve({ error: error(caught) }));
      } catch (caught) {
        resolve({ error: error(caught) });
      }
    });
  const usb = list =>
    Array.isArray(list) ? list.find(one => one.type === "EXTERNAL" && one.state === "MOUNTED") : undefined;
  let list = await storages();
  const result = {
    storages: Array.isArray(list) ? list.map(one => [one.label, one.type, one.state]) : list,
  };
  for (let waited = 0; !usb(list) && waited < (input.wait ?? 0); waited++) {
    await sleep(1000);
    list = await storages();
  }
  const drive = input.drive ? list.find?.(one => one.label === input.drive) : usb(list);
  if (!drive) return { ...result, error: "No USB drive mounted: plug one in" };
  result.drive = drive.label;

  // The drive's folder.
  const folder = await new Promise(resolve => {
    try {
      fs.resolve(drive.label, resolve, caught => resolve({ error: error(caught) }), "rw");
    } catch (caught) {
      resolve({ error: error(caught) });
    }
  });
  if (!folder || folder.error) return { ...result, error: `Can't open the drive: ${folder?.error}` };
  result.path = folder.fullPath;
  const name = "tiviplayer-probe.ts";
  try {
    folder.deleteFile(`${folder.fullPath}/${name}`);
  } catch {
    // Not there.
  }

  // A writer: FileHandle (Tizen 5+), or the older FileStream.
  let write;
  let close;
  const path = `${folder.fullPath}/${name}`;
  try {
    const handle = fs.openFile(path, "w");
    write = bytes => handle.writeData(bytes);
    close = () => handle.close();
    result.api = "openFile";
  } catch (caught) {
    result.openFileError = error(caught);
    try {
      const file = folder.createFile(name);
      const stream = await new Promise((resolve, reject) => file.openStream("w", resolve, reject));
      write = bytes => stream.writeBytes(Array.from(bytes));
      close = () => stream.close();
      result.api = "openStream";
    } catch (again) {
      return { ...result, error: `Can't write: ${error(again)}` };
    }
  }

  // Record.
  const seconds = input.seconds ?? 60;
  const response = await fetch(`${input.server}/ts/${input.stream ?? "h264-aac"}.ts`);
  const reader = response.body.getReader();
  let bytes = 0;
  let writing = 0;
  let longest = 0;
  let writes = 0;
  let failed;
  // How late the page's frames came, as a sign of writes blocking it.
  let frames = 0;
  let lateFrame = 0;
  let last = performance.now();
  let drawing = true;
  const frame = now => {
    frames++;
    lateFrame = Math.max(lateFrame, now - last);
    last = now;
    if (drawing) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const started = performance.now();
  while (performance.now() - started < seconds * 1000) {
    const { value, done } = await reader.read();
    if (done) break;
    const before = performance.now();
    try {
      write(value);
    } catch (caught) {
      failed = error(caught);
      break;
    }
    const took = performance.now() - before;
    writing += took;
    longest = Math.max(longest, took);
    writes++;
    bytes += value.length;
    if (writes % 200 === 0)
      log("writing", {
        mb: Math.round(bytes / 1e5) / 10,
        s: Math.round((performance.now() - started) / 1000),
      });
  }
  drawing = false;
  reader.cancel().catch(() => undefined);
  try {
    close();
  } catch (caught) {
    failed ??= error(caught);
  }
  const elapsed = (performance.now() - started) / 1000;
  result.record = {
    seconds: Math.round(elapsed),
    mb: Math.round(bytes / 1e5) / 10,
    streamMbitPerSecond: Math.round((bytes * 8) / elapsed / 1e5) / 10,
    writes,
    writeMsTotal: Math.round(writing),
    writeMbPerSecond: writing > 0 ? Math.round(bytes / 1e3 / writing) : undefined,
    longestWriteMs: Math.round(longest),
    framesPerSecond: Math.round(frames / elapsed),
    latestFrameMs: Math.round(lateFrame),
    error: failed,
  };
  log("record", result.record);

  // Play it back.
  try {
    result.fileSize = await new Promise(resolve =>
      fs.resolve(
        path,
        file => {
          result.uri = file.toURI();
          resolve(file.fileSize);
        },
        () => resolve(undefined),
        "r",
      ),
    );
  } catch {
    // Not known.
  }
  location.hash = "#/dev/video";
  await sleep(1000);
  // AVPlay needs the real path, not the virtual one.
  void player.play({ url: result.uri ?? `file://${path}` });
  const start = performance.now();
  while (
    player.status().state !== "playing" &&
    player.status().state !== "failed" &&
    performance.now() - start < 15_000
  ) {
    await sleep(100);
  }
  const playback = {
    state: player.status().state,
    error: player.status().error,
    startMs: Math.round(performance.now() - start),
  };
  await sleep(3000);
  playback.positionMs = Math.round(player.position());
  playback.durationMs = Math.round(player.duration());
  result.playback = playback;
  player.stop();
  location.hash = "#/";
  if (!input.keep) {
    try {
      folder.deleteFile(path);
      result.deleted = true;
    } catch (caught) {
      result.deleted = error(caught);
    }
  }
  return result;
}
