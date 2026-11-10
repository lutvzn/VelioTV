// Velio Sync, Phase 0 (VelioPlatform's PLAN.md): can the app reach the sync
// Worker, how long does checking and decrypting an account take with
// TweetNaCl as the app's build has it (`window.velio.nacl`), and does a
// WebSocket to the Worker get each "rev N"?
//
// The Worker's test account has 3 profiles and 20 lists. Opening it, as a TV
// will on each pull, is: check the manifest's Ed25519 signature, open 3
// boxed profile keys (X25519), then for each profile's lists unwrap the list
// key and decrypt the list (34 in all). Phase 0 is passed at under 200 ms.
//
// Input:
//   "base": "https://velio-sync.<subdomain>.workers.dev"   the Worker (or http://<dev-ip>:8787 for wrangler dev)
//   "runs": 5                                              times to open the account (the first is cold)

async function probe(input) {
  const nacl = window.velio.nacl;
  const base = input.base.replace(/\/$/, "");
  const runs = input.runs || 5;
  const now = () => performance.now();
  const ms = since => Math.round((now() - since) * 10) / 10;

  // XHR rather than fetch, as it is there on every TV; a TLS failure shows as status 0.
  const get = url =>
    new Promise(resolve => {
      const started = now();
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.timeout = 20000;
      const done = error => resolve({ status: xhr.status, ms: ms(started), text: xhr.responseText, error });
      xhr.addEventListener("load", () => done());
      xhr.addEventListener("error", () => done("network error"));
      xhr.addEventListener("timeout", () => done("timed out"));
      xhr.send();
    });

  const bytes = base64 => {
    const text = atob(base64);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  };
  const fromUtf8 = data =>
    typeof TextDecoder !== "undefined"
      ? new TextDecoder("utf-8", { fatal: true }).decode(data)
      : decodeURIComponent(escape(String.fromCharCode.apply(null, Array.prototype.slice.call(data))));
  // sync-core's padding: a 4-byte length, the bytes, then zeros.
  const unpad = data => {
    const length = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
    return data.subarray(4, 4 + length);
  };
  const openSealed = (key, sealed) => {
    const plain = nacl.secretbox.open(bytes(sealed.box), bytes(sealed.nonce), key);
    if (!plain) throw new Error("couldn't decrypt");
    return unpad(plain);
  };

  // What sync-core's openForDevice() does.
  const openAccount = account => {
    const t = { started: now() };
    const pull = account.pull;
    const manifestBytes = bytes(pull.manifest.body);
    if (
      !nacl.sign.detached.verify(
        manifestBytes,
        bytes(pull.manifest.signature),
        bytes(account.owner.signPublicKey),
      )
    )
      throw new Error("the manifest's signature doesn't match");
    const manifest = JSON.parse(fromUtf8(manifestBytes));
    t.verifyMs = ms(t.started);

    const boxStarted = now();
    const ownerBox = bytes(account.owner.boxPublicKey);
    const deviceSecret = bytes(account.device.secretKey);
    const profileKeys = {};
    for (const entry of pull.profileKeys) {
      const plain = nacl.box.open(bytes(entry.key.box), bytes(entry.key.nonce), ownerBox, deviceSecret);
      if (!plain) throw new Error(`couldn't open profile key ${entry.profile}`);
      profileKeys[entry.profile] = unpad(plain);
    }
    t.profileKeysMs = ms(boxStarted);

    const listsStarted = now();
    const byId = {};
    for (const list of pull.lists) byId[list.id] = list;
    const profiles = [];
    let opened = 0;
    for (const profile of manifest.profiles) {
      const key = profileKeys[profile.id];
      if (!key) continue;
      const name = JSON.parse(
        fromUtf8(openSealed(key, pull.profiles.find(p => p.id === profile.id).sealed)),
      ).name;
      const lists = profile.lists.map(entry => {
        const sealed = byId[entry.id];
        const wrapped = sealed.keys.find(k => k.profile === profile.id);
        const list = JSON.parse(fromUtf8(openSealed(openSealed(key, wrapped.key), sealed.sealed)));
        if (list.rev !== entry.rev) throw new Error(`list ${entry.id} isn't the manifest's revision`);
        opened++;
        return list;
      });
      profiles.push({ name, lists: lists.length });
    }
    t.listsMs = ms(listsStarted);
    t.totalMs = ms(t.started);
    delete t.started;
    return {
      timing: t,
      profiles,
      opened,
      firstList: profiles.length ? manifest.profiles[0].lists[0].id : null,
    };
  };

  const socketTest = () =>
    new Promise(resolve => {
      if (typeof WebSocket === "undefined") return resolve({ error: "no WebSocket" });
      const started = now();
      const out = { messages: [] };
      let socket;
      const finish = extra => {
        out.ms = ms(started);
        try {
          socket.close();
        } catch {
          // already closed
        }
        resolve(Object.assign(out, extra));
      };
      try {
        socket = new WebSocket(`${base.replace(/^http/, "ws")}/v1/probe/events`);
      } catch (error) {
        return resolve({ error: `${error.name}: ${error.message}` });
      }
      const timer = setTimeout(() => finish({ error: "timed out after 8 s" }), 8000);
      socket.addEventListener("open", () => {
        out.openMs = ms(started);
        socket.send("hello");
      });
      socket.addEventListener("message", event => {
        out.messages.push(`${event.data} @${ms(started)}`);
        if (out.messages.filter(m => m.indexOf("rev ") === 0).length === 5) {
          clearTimeout(timer);
          finish({ ok: out.messages.some(m => m.indexOf("echo hello") === 0) });
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        finish({ error: "socket error" });
      });
    });

  const result = { browser: navigator.userAgent, base };

  const reach = await get(`${base}/v1/probe`);
  result.reach = { status: reach.status, ms: reach.ms, error: reach.error };
  if (reach.status === 200) Object.assign(result.reach, JSON.parse(reach.text));
  else return result;

  const fetched = await get(`${base}/v1/probe/test-account`);
  if (fetched.status !== 200) {
    result.account = { status: fetched.status, error: fetched.error };
    return result;
  }
  const parseStarted = now();
  const account = JSON.parse(fetched.text);
  result.account = { bytes: fetched.text.length, downloadMs: fetched.ms, parseMs: ms(parseStarted) };

  const timings = [];
  let last;
  try {
    for (let i = 0; i < runs; i++) {
      last = openAccount(account);
      timings.push(last.timing);
    }
  } catch (error) {
    result.open = { error: `${error.name}: ${error.message}`, timings };
    return result;
  }
  // Not toSorted(), which older TVs lack.
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
  const totals = timings.map(t => t.totalMs).sort((a, b) => a - b);
  result.open = {
    profiles: last.profiles,
    opened: last.opened,
    first: timings[0],
    medianTotalMs: totals[Math.floor(totals.length / 2)],
    maxTotalMs: totals[totals.length - 1],
    passed: timings[0].totalMs < 200,
  };

  result.socket = await socketTest();
  return result;
}
