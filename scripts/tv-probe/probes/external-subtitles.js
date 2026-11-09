// Whether AVPlay plays subtitles from a separate SRT or WebVTT file, as
// Stremio subtitle add-ons give them, with setExternalSubtitlePath(). Plays
// the test film (MP4) once for each way of giving the file:
//   - its web address on the test server
//   - a copy saved in the app's private folder (wgt-private), by its path
//     on the TV, and by that path as a file:// URI
// For each it reports whether AVPlay took the path, the text tracks it
// listed, and every subtitle onsubtitlechange sent, with how far it was from
// the film's clock: each says the time it belongs to, such as "SRT 0:01:05".
// Then it seeks to 2:00 and watches again, to check they keep time after a
// seek. The subtitles are drawn at the bottom of the screen as they come, so
// you can watch; the way being tried is shown at the top.
//
// Takes about 1.5 minutes.
//
// Input: { "server": "http://<dev-ip>:8090" }
// Optional: "film" ("mp4", "mkv" or "ts"; default "mp4"), "watchSeconds"
// (default 4, before and after the seek), "only" (a list of the ways' names,
// to try just those).

async function probe(input) {
  const server = input.server;
  if (!server) return { error: "give the test server as `server`" };
  const film = `${server}/vod/film.${input.film ?? "mp4"}`;
  const watchMs = (input.watchSeconds ?? 4) * 1000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log("[probe]", ...args);
  const av = webapis.avplay;
  const fs = tizen.filesystem;

  // Saves a copy of each file in wgt-private, and finds its path on the TV.
  const local = {};
  for (const format of ["srt", "vtt"]) {
    const text = await (await fetch(`${server}/vod/film.${format}`)).text();
    const virtual = `wgt-private/velio-probe-subtitles.${format}`;
    try {
      const file = fs.openFile(virtual, "w");
      file.writeString(text);
      file.close();
      const uri = fs.toURI(virtual);
      local[format] = { virtual, uri, path: uri.replace(/^file:\/\//, ""), bytes: text.length };
    } catch (error) {
      local[format] = { error: `${error?.name ?? ""}: ${error?.message ?? error}` };
    }
  }
  const ways = [
    { name: "srt web address", format: "srt", path: `${server}/vod/film.srt` },
    { name: "vtt web address", format: "vtt", path: `${server}/vod/film.vtt` },
    { name: "srt local path", format: "srt", path: local.srt.path },
    { name: "vtt local path", format: "vtt", path: local.vtt.path },
    { name: "srt local file:// URI", format: "srt", path: local.srt.uri },
  ].filter(way => !input.only || input.only.includes(way.name));

  // The video, with the subtitles and the way being tried drawn over it.
  const element = document.createElement("object");
  element.type = "application/avplayer";
  element.style.cssText = "position:absolute;left:0;top:0;width:1920px;height:1080px";
  document.body.appendChild(element);
  const box = "position:absolute;left:0;width:1920px;text-align:center;font:48px sans-serif;color:#fff";
  const caption = document.createElement("div");
  caption.style.cssText = `${box};bottom:80px;text-shadow:0 0 6px #000`;
  const heading = document.createElement("div");
  heading.style.cssText = `${box};top:40px;color:#ff0`;
  document.body.append(caption, heading);
  const canvas = document.querySelector("canvas");
  if (canvas) canvas.style.visibility = "hidden";

  const close = () => {
    for (const step of [() => av.stop(), () => av.close()]) {
      try {
        step();
      } catch {
        // Already stopped or closed.
      }
    }
  };
  const describe = error => `${error?.name ?? ""}: ${error?.message ?? error}`;
  // "SRT 0:01:05" as 65000 ms.
  const clockMs = text => {
    const match = text.match(/(\d+):(\d\d):(\d\d)/);
    return match ? (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 : undefined;
  };

  const results = { film, local, ways: [] };
  for (const way of ways) {
    const result = { name: way.name, path: way.path };
    heading.textContent = `Trying: ${way.name}`;
    caption.textContent = "";
    let subtitles = [];
    let hideTimer;
    close();
    try {
      if (!way.path) throw new Error("no path: the file couldn't be saved");
      av.open(film);
      av.setDisplayRect(0, 0, 1920, 1080);
      let buffered;
      const firstPicture = new Promise(resolve => (buffered = resolve));
      av.setListener({
        onerror: error => (result.playerError = String(error)),
        onbufferingcomplete: () => buffered(),
        onsubtitlechange: (duration, text, type, attributes) => {
          const clean = String(text ?? "").replace(/\0+$/, "");
          const at = av.getCurrentTime();
          const expected = clockMs(clean);
          subtitles.push({
            atMs: at,
            durationMs: Number(duration),
            text: clean,
            offByMs: expected === undefined ? undefined : at - expected,
            type,
            attributes,
          });
          caption.textContent = clean;
          clearTimeout(hideTimer);
          hideTimer = setTimeout(() => (caption.textContent = ""), Number(duration) || 1000);
        },
      });
      // AVPlay's docs give the external file before prepare; if that's
      // refused, it is tried again once prepared.
      try {
        av.setExternalSubtitlePath(way.path);
        result.setPath = "ok before prepare";
      } catch (error) {
        result.setPath = `refused before prepare: ${describe(error)}`;
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("didn't open within 15 s")), 15000);
        av.prepareAsync(
          () => (clearTimeout(timer), resolve()),
          error => (clearTimeout(timer), reject(error)),
        );
      });
      if (!result.setPath.startsWith("ok")) {
        try {
          av.setExternalSubtitlePath(way.path);
          result.setPath += "; ok once prepared";
        } catch (error) {
          result.setPath += `; refused once prepared: ${describe(error)}`;
        }
      }
      try {
        result.textTracks = av
          .getTotalTrackInfo()
          .filter(track => track.type === "TEXT")
          .map(track => ({ index: track.index, extra: track.extra_info }));
      } catch (error) {
        result.textTracks = describe(error);
      }
      try {
        av.setSilentSubtitle(false);
      } catch (error) {
        result.silentSubtitle = describe(error);
      }
      av.play();
      await Promise.race([
        firstPicture,
        sleep(20000).then(() => Promise.reject(new Error("no picture within 20 s"))),
      ]);
      await sleep(watchMs);
      result.fromStart = subtitles;
      subtitles = [];
      await new Promise((resolve, reject) => av.seekTo(120000, resolve, reject));
      await sleep(watchMs);
      result.afterSeekTo2Min = subtitles;
      const all = [...result.fromStart, ...result.afterSeekTo2Min];
      const offsets = all.map(s => s.offByMs).filter(ms => ms !== undefined);
      result.summary = {
        subtitles: all.length,
        offByMs: offsets.length ? [Math.min(...offsets), Math.max(...offsets)] : undefined,
      };
    } catch (error) {
      result.error = describe(error);
    }
    clearTimeout(hideTimer);
    log(way.name, JSON.stringify(result.error ?? { setPath: result.setPath, ...result.summary }));
    results.ways.push(result);
  }

  close();
  for (const format of ["srt", "vtt"]) {
    try {
      if (local[format].virtual) fs.deleteFile(local[format].virtual);
    } catch {
      // Left behind; it's small.
    }
  }
  element.remove();
  caption.remove();
  heading.remove();
  if (canvas) canvas.style.visibility = "";
  return results;
}
