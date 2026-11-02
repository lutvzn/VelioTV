// Phase 0 test 2: whether the UI stays smooth over playing video. Opens the
// app's developer page (src/pages/dev/VideoTest.tsx) with a stream, then
// scrolls its list in the preview window and at full screen, reporting the
// frame rate in each. Watch the TV while it runs.
//
// Input: { "url": "<stream URL>", "seconds": 15 } (seconds per mode)

async function probe(input) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log("[probe]", ...args);
  const press = keyCode => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
    }
  };
  const seconds = input.seconds ?? 15;

  location.hash = `#/dev/video?url=${encodeURIComponent(input.url)}`;
  for (let i = 0; i < 40 && window.videoTestStats?.state !== "playing"; i++) await sleep(500);
  if (window.videoTestStats?.state !== "playing")
    return { error: `video didn't start: ${window.videoTestStats?.state}` };

  // Scrolls down and back up the list for the given time, two moves a second.
  const scroll = async () => {
    const moves = seconds * 2;
    for (let i = 0; i < moves; i++) {
      press(i % 20 < 10 ? 40 : 38);
      await sleep(500);
    }
  };
  const measure = async mode => {
    const samples = [];
    const sampler = setInterval(() => samples.push(window.videoTestStats.fps), 1000);
    await scroll();
    clearInterval(sampler);
    const average = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
    log(mode, `average ${average} fps, lowest ${Math.min(...samples)}`);
    return { average, lowest: Math.min(...samples), samples: samples.join(" ") };
  };

  const results = { preview: await measure("preview") };
  press(13);
  await sleep(1000);
  results.fullScreen = await measure("full screen");
  press(13);
  results.state = window.videoTestStats.state;
  return results;
}
