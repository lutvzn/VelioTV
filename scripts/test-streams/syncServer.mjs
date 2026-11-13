// Velio Sync on the test server (SYNC-PLAN.md): a made-up account (sync.ts,
// built from sync-core's own server side) that a TV signs in to, as it
// would at velio.tv. Point the TV's Account page at this server (a probe
// calls sync.setSite("http://<host>:<port>") while signed out), then:
//
//   /v1/pair, /v1/pair/:id, /v1/sync, /v1/signout   the TV's API
//   /v1/events                                       its WebSocket
//
// /pair is the phone's page, as at velio.tv: the TV's QR code opens it.
//
// The owner's side, as GET requests answering JSON, for a probe or a browser:
//
//   /sync/                                 what the account holds
//   /sync/approve?code=K7QM-…&profiles=Kids,Guest   the phone's half of
//                                          signing in (all profiles if none)
//   /sync/add-list?name=…&channels=20&profiles=Kids
//   /sync/add-list?kind=stremio&profiles=Living%20room  the test add-on (stremio.mjs);
//     with &path=/debrid/key=velio-test/manifest.json, the debrid one (debrid.mjs)
//   /sync/change-list?list=…&name=…&profiles=…
//   /sync/remove-list?list=…
//   /sync/pin?profile=Kids&pin=1234        no pin= removes it
//   /sync/rename?profile=…&name=…
//   /sync/device-profiles?profiles=Kids    the TV last signed in
//   /sync/remove-device                    the same TV
//   /sync/close                            closes the account
//   /sync/reset                            a new account, as at the start
//
// sync.ts is TypeScript, as are sync-core's files, which import each other
// without extensions: a resolve hook finds their .ts files, and a load hook
// turns them into JavaScript with Node's own stripTypeScriptTypes().

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts") && !/\.[cm]?[jt]s$/.test(specifier)) {
      for (const ending of [".ts", "/index.ts"]) {
        const url = new URL(specifier + ending, context.parentURL);
        if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  // sync-core has TypeScript that only strips with a transform, such as
  // constructor parameter properties.
  load: (url, context, nextLoad) => {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), {
      mode: "transform",
      sourceUrl: url,
    });
    return { format: "module", source, shortCircuit: true };
  },
});

const { createSyncMock, testAddon, testList, CORS } = await import("./sync.ts");
const { readEventsProtocols } = await import("../../src/sync-core/events.ts");

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let mock;
/**
 * The account, made at the first request (or /sync/reset), with lists at
 * the address that request used: use the address the TV uses.
 */
const account = base => {
  mock ??= createSyncMock({ base });
  return mock;
};

const readBody = req =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(value, null, 2));
};

const list = value =>
  value
    ? value
        .split(",")
        .map(part => part.trim())
        .filter(Boolean)
    : undefined;

/** The owner's actions, by name. */
const OWNER = {
  "": sync => sync.summary(),
  approve: (sync, query) => sync.approve(query.get("code") ?? "", list(query.get("profiles"))),
  "add-list": (sync, query, base) => ({
    id: sync.addList(
      query.get("kind") === "stremio"
        ? testAddon(base, query.get("name") ?? "Test add-on", query.get("path") ?? undefined)
        : testList(base, query.get("name") ?? "Added list", Number(query.get("channels")) || 20),
      list(query.get("profiles")) ?? [],
    ),
  }),
  "change-list": (sync, query) => {
    const change = {};
    if (query.get("name")) change.name = query.get("name");
    if (query.get("url")) change.url = query.get("url");
    if (query.get("disabled")) change.disabled = query.get("disabled") === "1";
    sync.changeList(query.get("list") ?? "", change, list(query.get("profiles")));
    return sync.summary();
  },
  "remove-list": (sync, query) => {
    sync.removeList(query.get("list") ?? "");
    return sync.summary();
  },
  pin: (sync, query) => {
    sync.setPin(query.get("profile") ?? "", query.get("pin") || null);
    return sync.summary();
  },
  rename: (sync, query) => {
    sync.renameProfile(query.get("profile") ?? "", query.get("name") ?? "");
    return sync.summary();
  },
  "device-profiles": (sync, query) => {
    sync.setDeviceProfiles(list(query.get("profiles")) ?? [], query.get("device") ?? undefined);
    return sync.summary();
  },
  "remove-device": (sync, query) => {
    sync.removeDevice(query.get("device") ?? undefined);
    return sync.summary();
  },
  close: sync => {
    sync.close();
    return sync.summary();
  },
};

// The phone's half of signing in, as velio.tv's /pair page does it: the QR
// code opens this with the pairing in the address's #, and the owner picks
// the TV's profiles. Typing the code works too.
const PAIR_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in a TV (test account)</title>
<style>
  body { font: 18px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 30rem; padding: 1rem; background: #07090e; color: #f5f8fc; }
  input[type=text] { font: inherit; width: 100%; box-sizing: border-box; padding: .6rem; text-transform: uppercase; }
  label { display: block; padding: .5rem 0; }
  input[type=checkbox] { transform: scale(1.4); margin-right: .7rem; }
  button { font: inherit; font-weight: 600; width: 100%; padding: .8rem; margin-top: 1rem; border: 0; border-radius: 2rem; background: #00e5ff; color: #00252a; }
  .note { color: #9eabbf; font-size: .9rem; }
  #result { margin-top: 1rem; font-weight: 600; }
</style>
<h1>Sign in a TV</h1>
<p class="note">The test server's made-up account. velio.tv does this for real.</p>
<p><label>Code <input id="code" type="text" placeholder="K7QM-2XHF-9WRT" autocomplete="off"></label></p>
<p>Profiles for this TV:</p>
<div id="profiles"></div>
<button id="go">Sign in the TV</button>
<p id="result"></p>
<script>
  const code = document.getElementById("code");
  const result = document.getElementById("result");
  // From the QR code: the whole address, which the server reads as a QR pairing.
  if (location.hash.length > 1) { code.value = location.href; code.readOnly = true; code.style.textTransform = "none"; }
  fetch("/sync/").then(r => r.json()).then(account => {
    const list = document.getElementById("profiles");
    for (const profile of account.profiles) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox"; box.checked = true; box.value = profile.name;
      label.append(box, profile.name + (profile.pin ? " (PIN)" : ""));
      list.append(label);
    }
  });
  document.getElementById("go").addEventListener("click", async () => {
    const profiles = [...document.querySelectorAll("#profiles input:checked")].map(box => box.value);
    if (profiles.length === 0) { result.textContent = "Pick at least one profile."; return; }
    const query = new URLSearchParams({ code: code.value.trim(), profiles: profiles.join(",") });
    const response = await fetch("/sync/approve?" + query);
    const body = await response.json();
    result.textContent = response.ok ? "Done: " + body.name + " is signed in." : body.problem;
  });
</script>
</html>
`;

/** Answers /pair, /v1/* and /sync/*; false for anything else. */
export const handleSync = (req, res, url, base) => {
  if (url.pathname === "/pair") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(PAIR_PAGE);
    return true;
  }
  if (url.pathname.startsWith("/v1/")) {
    void (async () => {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === "string") headers.set(name, value);
      const answer = await account(base).fetch(
        new Request(new URL(url.pathname + url.search, base), { method: req.method, headers, body }),
      );
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    })().catch(error => {
      console.error("Sync mock:", error);
      if (!res.headersSent) json(res, 500, { problem: String(error) });
    });
    return true;
  }
  const owner = url.pathname.match(/^\/sync\/?([a-z-]*)$/);
  if (!owner) return false;
  if (owner[1] === "reset") {
    mock?.close();
    mock = undefined;
    json(res, 200, account(base).summary());
    return true;
  }
  const action = OWNER[owner[1]];
  if (!action) {
    json(res, 404, { problem: `No action ${owner[1]}` });
    return true;
  }
  try {
    json(res, 200, action(account(base), url.searchParams, base));
  } catch (error) {
    json(res, 400, { problem: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** A text or close frame, from the server: unmasked. */
const frame = (opcode, payload) => {
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const big = Buffer.alloc(10);
            big[0] = 0x80 | opcode;
            big[1] = 127;
            big.writeBigUInt64BE(BigInt(length), 2);
            return big;
          })();
  return Buffer.concat([head, payload]);
};

/** The events socket, /v1/events: a small WebSocket server, enough for the TV. */
export const upgradeSync = (req, socket, base) => {
  const url = new URL(req.url ?? "/", base);
  if (url.pathname !== "/v1/events") return false;
  const key = req.headers["sec-websocket-key"];
  const token = readEventsProtocols(req.headers["sec-websocket-protocol"]);
  let closed = false;
  // Frames wait for the handshake's answer: connect() sends "rev N" at once.
  let ready = false;
  const waiting = [];
  const write = (data, end = false) => {
    if (!ready) waiting.push([data, end]);
    else if (end) socket.end(data);
    else socket.write(data);
  };
  const ws = {
    send: text => {
      if (!closed) write(frame(1, Buffer.from(text)));
    },
    close: code => {
      if (closed) return;
      closed = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code);
      write(frame(8, payload), true);
    },
  };
  if (!key) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return true;
  }
  const accept = createHash("sha1")
    .update(key + WEBSOCKET_GUID)
    .digest("base64");
  const sync = account(base);
  const handler = sync.connect(token, {
    send: text => ws.send(text),
    close: code => ws.close(code),
  });
  if (!handler) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return true;
  }
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "Sec-WebSocket-Protocol: velio-events.1",
      "",
      "",
    ].join("\r\n"),
  );
  ready = true;
  for (const [data, end] of waiting.splice(0)) write(data, end);

  let buffered = Buffer.alloc(0);
  socket.on("data", chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const opcode = buffered[0] & 0x0f;
      let length = buffered[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        length = Number(buffered.readBigUInt64BE(2));
        at = 10;
      }
      const masked = (buffered[1] & 0x80) !== 0;
      const mask = masked ? buffered.subarray(at, at + 4) : undefined;
      if (masked) at += 4;
      if (buffered.length < at + length) return;
      const payload = Buffer.from(buffered.subarray(at, at + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffered = buffered.subarray(at + length);
      if (opcode === 1) handler.message(payload.toString());
      else if (opcode === 9) socket.write(frame(10, payload));
      else if (opcode === 8) {
        handler.closed();
        if (!closed) {
          closed = true;
          socket.end(frame(8, payload.subarray(0, 2)));
        }
      }
    }
  });
  const gone = () => {
    closed = true;
    handler.closed();
  };
  socket.on("close", gone);
  socket.on("error", gone);
  return true;
};
