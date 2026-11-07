// Records the key events the remote sends, to see what a held key looks
// like on this TV (key-downs, repeats, key-ups and the time between them).
// Press and hold keys on the remote while it runs. It stops 10 s after the
// last key once it has seen a few, or after "maxMs".
//
// Input, all optional:
//   "maxMs": 300000
//   "quietMs": 10000   stop this long after the last key
//   "minKeys": 3       key-downs to see before stopping when quiet

async function probe(input) {
  const { maxMs = 300_000, quietMs = 10_000, minKeys = 3 } = input;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const start = performance.now();
  const events = [];
  let downs = 0;
  let last = start;
  const record = event => {
    const now = performance.now();
    if (event.type === "keydown") downs++;
    events.push({
      t: Math.round(now - start),
      gap: Math.round(now - last),
      type: event.type === "keydown" ? "down" : "up",
      keyCode: event.keyCode,
      key: event.key,
      repeat: event.repeat,
    });
    last = now;
  };
  window.addEventListener("keydown", record, true);
  window.addEventListener("keyup", record, true);
  console.log("[probe] recording keys");
  while (performance.now() - start < maxMs) {
    await sleep(200);
    if (downs >= minKeys && performance.now() - last > quietMs) break;
  }
  window.removeEventListener("keydown", record, true);
  window.removeEventListener("keyup", record, true);
  return { downs, events: events.slice(0, 300) };
}
