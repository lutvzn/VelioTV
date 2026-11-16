// The account on the test server (SYNC-PLAN.md): a made-up account on a
// fake Nuvio server (nuvio.ts) that a TV signs in to, as it would at
// velio.tv. Point the TV's Account page at this server (a probe calls
// sync.setSite("http://<host>:<port>") while signed out), then:
//
//   /.well-known/nuvio, /auth/v1/*, /rest/v1/*, /functions/v1/*   the TV's API
//
// /link (and /tv-login) is the phone's page, as at velio.tv: the TV's QR
// code opens it with the code, or the code is typed there.
//
// The owner's side, as GET requests answering JSON, for a probe or a browser:
//
//   /sync/                                 what the account holds
//   /sync/approve?code=K7QM2X              the phone's half of signing in
//   /sync/add-list?name=…&channels=20&profiles=Kids
//   /sync/add-list?kind=stremio&profiles=Living%20room  the test add-on (stremio.mjs);
//     with &path=/debrid/key=velio-test/manifest.json, the debrid one (debrid.mjs)
//   /sync/change-list?list=…&name=…&profiles=…
//   /sync/remove-list?list=…
//   /sync/pin?profile=Kids&pin=1234        no pin= removes it
//   /sync/rename?profile=…&name=…
//   /sync/remove-device                    signs the TVs out, as the devices page does
//   /sync/close                            closes the account
//   /sync/reset                            a new account, as at the start

import { createNuvioFake, CORS, testAddon, testList } from "./nuvio.ts";

let fake;
/**
 * The account, made at the first request (or /sync/reset), with lists at
 * the address that request used: use the address the TV uses.
 */
const account = base => {
  fake ??= createNuvioFake({ base });
  return fake;
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
  approve: (sync, query) => sync.approve(query.get("code") ?? ""),
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
  "remove-device": sync => {
    sync.removeDevice();
    return sync.summary();
  },
  close: sync => {
    sync.close();
    return sync.summary();
  },
};

// The phone's half of signing in, as velio.tv's /link page does it: the QR
// code opens this with the code, or the code is typed.
const LINK_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in a TV (test account)</title>
<style>
  body { font: 18px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 30rem; padding: 1rem; background: #07090e; color: #f5f8fc; }
  input[type=text] { font: inherit; width: 100%; box-sizing: border-box; padding: .6rem; text-transform: uppercase; }
  button { font: inherit; font-weight: 600; width: 100%; padding: .8rem; margin-top: 1rem; border: 0; border-radius: 2rem; background: #00e5ff; color: #00252a; }
  .note { color: #9eabbf; font-size: .9rem; }
  #result { margin-top: 1rem; font-weight: 600; }
</style>
<h1>Sign in a TV</h1>
<p class="note">The test server's made-up account. velio.tv does this for real.</p>
<p><label>Code <input id="code" type="text" placeholder="K7QM2X" autocomplete="off"></label></p>
<button id="go">Sign in the TV</button>
<p id="result"></p>
<script>
  const code = document.getElementById("code");
  const result = document.getElementById("result");
  const given = new URLSearchParams(location.search).get("code");
  if (given) code.value = given;
  document.getElementById("go").addEventListener("click", async () => {
    const response = await fetch("/sync/approve?" + new URLSearchParams({ code: code.value.trim() }));
    const body = await response.json();
    result.textContent = response.ok ? "Done: " + body.name + " is signed in." : body.problem;
  });
</script>
</html>
`;

const API = /^\/(\.well-known\/nuvio$|auth\/v1\/|rest\/v1\/|functions\/v1\/)/;

/** Answers the API, /link and /sync/*; false for anything else. */
export const handleSync = (req, res, url, base) => {
  if (url.pathname === "/link" || url.pathname === "/tv-login") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(LINK_PAGE);
    return true;
  }
  if (API.test(url.pathname)) {
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
      console.error("Fake Nuvio:", error);
      if (!res.headersSent) json(res, 500, { message: String(error) });
    });
    return true;
  }
  const owner = url.pathname.match(/^\/sync\/?([a-z-]*)$/);
  if (!owner) return false;
  if (owner[1] === "reset") {
    fake?.close();
    fake = undefined;
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
