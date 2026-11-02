// Runs a probe in the app over the Chrome DevTools protocol and prints its
// result as JSON. Called by run.sh; see there for usage.
//   node eval.mjs <devtools-websocket-url> <probe.js> <input-json> <timeout-seconds>

import { readFileSync } from "node:fs";

const [wsUrl, probeFile, input = "{}", timeoutSeconds = "900"] = process.argv.slice(2);

// Each probe file declares `async function probe(input)`.
const expression = `${readFileSync(probeFile, "utf8")}\nprobe(${input});`;

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise(resolve => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  // Probes report progress with console.log("[probe]", ...).
  if (message.method === "Runtime.consoleAPICalled") {
    const [first, ...rest] = message.params.args;
    if (first?.value === "[probe]") console.error(rest.map(arg => arg.value ?? arg.description).join(" "));
  }
});

ws.addEventListener("open", async () => {
  await call("Runtime.enable");
  // Lets the app finish starting.
  await new Promise(resolve => setTimeout(resolve, 2500));
  const { result } = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result?.exceptionDetails) {
    console.error(
      "The probe threw:",
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
    process.exit(1);
  }
  console.log(JSON.stringify(result?.result?.value, null, 2));
  process.exit(0);
});

setTimeout(
  () => {
    console.error(`The probe didn't finish within ${timeoutSeconds} s.`);
    process.exit(1);
  },
  Number(timeoutSeconds) * 1000,
);
