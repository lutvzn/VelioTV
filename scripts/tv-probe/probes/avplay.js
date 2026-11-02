// Plays streams through Samsung's AVPlay and reports, for each one, whether
// it played, how long it took to start, and its video and audio formats.
//
// Input, one of:
//   { "index": "http://<test-stream-server>/" }   every stream from
//       scripts/test-streams/server.mjs, as raw TS and HLS, plus its
//       header tests
//   { "streams": [{ "name": "...", "url": "...", "userAgent": "..." }] }
// Optional: "playSeconds" (default 5) to watch each stream for, and
// "bufferSeconds" to change how much AVPlay buffers before it starts.
//
// "startMs" is the time from opening a stream to its first picture. AVPlay
// reports that a stream is prepared before it has buffered enough to show
// anything, so the probe waits for buffering to finish.
//
// The app's canvas is hidden while it runs, so the video shows on the TV.

async function probe(input) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log("[probe]", ...args);

  const streamsFromIndex = async url => {
    const index = await (await fetch(url)).json();
    const streams = index.streams.flatMap(s => [
      { name: `${s.label} | TS`, url: s.ts },
      { name: `${s.label} | HLS`, url: s.hls },
    ]);
    for (const test of index.headerTests) {
      for (const kind of ["ts", "hls"]) {
        streams.push({ name: `needs ${test.header}, not sent | ${kind}`, url: test[kind] });
        if (test.header === "User-Agent") {
          streams.push({
            name: `needs ${test.header}, sent | ${kind}`,
            url: test[kind],
            userAgent: test.value,
          });
        }
      }
    }
    return streams;
  };

  const streams = input.index ? await streamsFromIndex(input.index) : input.streams;
  const playMs = (input.playSeconds ?? 5) * 1000;

  const element = document.createElement("object");
  element.type = "application/avplayer";
  element.style.cssText = "position:absolute;left:0;top:0;width:1920px;height:1080px";
  document.body.appendChild(element);
  const canvas = document.querySelector("canvas");
  if (canvas) canvas.style.visibility = "hidden";

  const av = webapis.avplay;
  const close = () => {
    for (const step of [() => av.stop(), () => av.close()]) {
      try {
        step();
      } catch {
        // Already stopped or closed.
      }
    }
  };
  const formats = () =>
    av.getCurrentStreamInfo().map(info => {
      const extra = JSON.parse(info.extra_info || "{}");
      const size = extra.Width ? ` ${extra.Width}x${extra.Height}` : "";
      const audio = extra.channels ? ` ${extra.channels}ch ${extra.sample_rate} Hz` : "";
      return `${info.type} ${extra.fourCC ?? "?"}${size}${audio}`;
    });

  const results = [];
  for (const stream of streams) {
    const result = { name: stream.name, url: stream.url };
    const started = performance.now();
    close();
    try {
      av.open(stream.url);
      if (stream.userAgent) av.setStreamingProperty("USER_AGENT", stream.userAgent);
      av.setDisplayRect(0, 0, 1920, 1080);
      if (input.bufferSeconds) {
        for (const when of ["PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_FOR_RESUME"]) {
          av.setBufferingParam(when, "PLAYER_BUFFER_SIZE_IN_SECOND", input.bufferSeconds);
        }
      }
      let buffered;
      const firstPicture = new Promise(resolve => (buffered = resolve));
      av.setListener({
        onerror: error => (result.playerError = String(error)),
        onbufferingcomplete: () => buffered(),
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("didn't open within 15 s")), 15000);
        av.prepareAsync(
          () => {
            clearTimeout(timer);
            resolve();
          },
          error => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      av.play();
      await Promise.race([
        firstPicture,
        sleep(20000).then(() => Promise.reject(new Error("no picture within 20 s"))),
      ]);
      result.startMs = Math.round(performance.now() - started);
      const from = av.getCurrentTime();
      await sleep(playMs);
      result.advancedMs = av.getCurrentTime() - from;
      result.state = av.getState();
      // Under about 80% of real time means it stalled.
      result.played = result.advancedMs > playMs * 0.8;
      result.formats = formats();
    } catch (error) {
      result.played = false;
      result.error = `${error?.name ?? ""}: ${error?.message ?? error}`;
    }
    const detail =
      result.error ?? `started in ${result.startMs} ms, ${result.advancedMs} ms played, ${result.state}`;
    log(result.played ? "played" : "FAILED", stream.name, detail);
    results.push(result);
  }

  close();
  element.remove();
  if (canvas) canvas.style.visibility = "";
  return results;
}
