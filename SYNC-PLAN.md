# Velio Sync in VelioTV: implementation plan

**The server side of Velio Sync is built. What's left is VelioTV's half: signing a TV in by QR code, pulling and decrypting its lists, profiles on the TV, live updates, and signing out when the TV is removed.** This file is the plan for that half, written 2026-11-10, for picking the work up from this repo.

The design, the server, and what each server phase built are in VelioPlatform's `PLAN.md` (`../VelioPlatform/PLAN.md`). Read its sections "Accounts, profiles and lists", "Signing in a TV", "VelioTV pulling" and "VelioTV changes" before starting. When the two disagree, that file is the design; this one is the order of work on the TV.

## Where things stand

| Phase (VelioPlatform's numbering) | Server and web            | VelioTV                                                    |
| --------------------------------- | ------------------------- | ---------------------------------------------------------- |
| 0 TV checks                       | Done                      | Speed, HTTPS and the socket checked; 2 items left (step 9) |
| 1 Accounts                        | Deployed                  | Nothing: TVs never sign in with a password                 |
| 2 Profiles and lists              | Deployed                  | Nothing                                                    |
| 3 TV sign-in and pull             | Deployed                  | Built (steps 1–4); the test TV's run is left               |
| 4 Profiles on the TV              | Deployed (pictures, PINs) | Built (step 5); the test TV's run is left                  |
| 5 Live updates                    | Deployed                  | Built (step 6); hours-long runs are left                   |
| 6 Devices                         | Deployed                  | Built (step 7)                                             |
| 7 Hardening                       | Deployed                  | **To do** (step 8): a full run on the TV against velio.tv  |
| 8 Legal and abuse                 | Deployed                  | Nothing new: a closed account looks like a removed TV      |

Everything above is deployed on velio.tv (version a0b0e0ed, 2026-11-10), including `POST /v1/signout`. VelioPlatform is a git repo (branch `master`) since 2026-11-10, with no remote yet.

## Rules for this work

- **Where:** VelioTV work happens in the `tv-dev` distrobox, as `AGENTS.md` says. Server and `sync-core` work happens in VelioPlatform, **on the host**, never in a box. If the TV needs something new from the server, change it there, with its own tests, and deploy only when the user asks.
- **One address:** everything is on `https://velio.tv`, with no subdomains: the site, the pairing page, `/v1` and `wss://velio.tv/v1/events`.
- **Old TVs:** everything below runs in the ES5 legacy build on Chromium 47 and 38. `pnpm check:old-tvs` must pass. No `BigInt`, no WebCrypto, no Proxy; TweetNaCl only needs `crypto.getRandomValues`.
- **Crypto off the UI's thread:** Phase 0 measured 231–263 ms for a cold open on the test TV, mostly the Ed25519 check. So opening a pull runs in a worker, and only when the manifest changed (a 304 needs no crypto).
- **The TV only reads.** It never sends lists, profiles or changes back.
- **Text** through `$t()`/`$tn()` with keys in every `src/lang/*.json`. New pages follow the voice guide's rules.
- **Test data:** made-up accounts and lists only (hosts on `example.invalid`, or the test server's own sources). No real playlists, and no real account's email or keys in the repo.

## What the TV uses from `sync-core`

`packages/sync-core` in VelioPlatform is the shared code. The TV needs these (all in its `index.ts`; never `@velio/sync-core/login`, which loads hash-wasm's Argon2id):

| File         | What the TV uses                                                                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairing.ts` | `newPairingSecrets()`, `pairRequest(secrets, {format: 1, publicKey, name})`, `pairingUrl(site, id, secrets)` for the QR code, `pairingCode(id, secrets)` to show, `openPairingPayload(kind, secrets, payload, myPublicKey)`, `MAX_DEVICE_NAME_LENGTH` (40) |
| `device.ts`  | `openPull(trust, json, previous?)` → `DeviceView` (`rev`, `profiles`, `lists`); `DeviceTrust`; `DeviceRemoved`                                                                                                                                             |
| `events.ts`  | `eventsUrl(site)`, `eventsProtocols(token)`, `readEvent(data)`, `PING`, `PING_EVERY_MS` (45 s), `EVENTS_CLOSE`, `reconnectDelay(attempt)`. Its header comment says what the TV does with each message                                                      |
| `records.ts` | `SyncedList` (VelioTV's `Source` plus `format` and `rev`), `PROFILE_COLORS`, `PROFILE_LETTER_COLOR`, `profileColor()`, `profileInitial()`, `profilePinMatches()`                                                                                           |
| `crypto.ts`  | `newBoxKeyPair()` for the TV's device key                                                                                                                                                                                                                  |
| `bytes.ts`   | `toBase64()`, written by hand for Chromium 38                                                                                                                                                                                                              |

`openPull()` already checks everything the TV must check: the owner's signature, the account, that the revision doesn't go back, that the manifest names this TV, that profile keys were boxed by the owner's box key, and that every record is the revision the manifest names. It reuses lists whose revision didn't change when given the previous view, and throws `DeviceRemoved` once the manifest stops naming the TV.

VelioPlatform's `apps/sync/test/tv.ts` simulates a whole TV in Node with these functions (`newTv`, `pickUp`, `pull`, `signedInTv`, `connect`). Copy its shape for VelioTV's tests.

## The server's `/v1`, as the TV sees it

All JSON. `Authorization: Bearer <token>`, no cookies, CORS open. Errors are `{"problem": "<text to show>"}`.

| Request                                                                | Answers                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/pair` with `pairRequest(...)`                                | 201 `{id, pollToken, expiresAt}`; 429 too many tries per address                                                                                                                                                                     |
| `GET /v1/pair/:id`, Bearer `pollToken`; waits up to 20 s for an answer | 200 `{status: "waiting", expiresAt}`; 200 `{status: "done", deviceId, deviceToken, kind, payload}`, **once**; 404 unknown; 410 expired or already picked up; 429 polled too often (20 a minute per address, so wait for each answer) |
| `GET /v1/sync`, Bearer device token, `If-None-Match: "<rev>"`          | 304 with `ETag: "<rev>"` when nothing changed; 200 with the pull (`SyncPull`) and its `ETag`; 401 when the TV was removed, the account was reset, deleted or closed, or the token is unknown                                         |
| `GET /v1/events` (WebSocket), subprotocols `eventsProtocols(token)`    | `rev N` on connecting and after each change; `removed` then close 4401 when this TV is gone; close 4409 when a newer socket of this TV took over; answers `ping` with `pong`                                                         |
| `POST /v1/signout`, Bearer device token                                | 204: the token stops working and the TV's sockets close; 401 for an unknown or already signed-out token. Call it when the user signs out, then forget the keys whatever it answers (offline, 401)                                    |
| `POST /v1/signin`, `POST /v1/changes`                                  | For future owner apps; the TV never uses them                                                                                                                                                                                        |

`POST /v1/signout` (added 2026-11-10) can only end the token: the TV stays in the account's signed manifest until the owner removes it, as only the owner can sign a change. The TVs page shows it as "Signed out on the TV" and offers only Remove for it.

## Steps

Each step ends with `pnpm check` (with `CI=1`) and `pnpm check:old-tvs` passing in the box, and its PLAN.md results written.

### 1. Bring `sync-core` into VelioTV

VelioPlatform is a git repo now, but has no remote yet, so a git dependency (the plan's first choice, VelioPlatform PLAN.md "Open choices", 6) only works once it's pushed to Forgejo; until then Forgejo CI can't see a path outside this repo.

**Recommended: copy the files in,** with a script that keeps them identical:

- `scripts/sync-core/copy.mjs` copies `../VelioPlatform/packages/sync-core/src/*.ts` into `src/sync-core/`, leaving out `login.ts` and `export.ts`, and writes a header on each naming where it came from. It also rewrites the `./x.ts` imports to `./x`, as VelioTV's `tsconfig.json` doesn't allow `.ts` extensions (or add `"allowImportingTsExtensions": true`, which `noEmit` permits; pick one).
- `--check` compares the copy with VelioPlatform's files when that folder is there, and is quiet when it isn't (CI).
- Change `sync-core` only in VelioPlatform, run its checks there, then copy again. Never edit `src/sync-core/` by hand.
- `tweetnacl` 1.0.3 is already a dependency (Phase 0).

If the user puts VelioPlatform on Forgejo first, use a git dependency instead and skip the script.

**Watch for:** `DeviceRemoved` and `CryptoProblem` are classes extending `Error`. Check in the legacy build that `error instanceof DeviceRemoved` still holds after Babel; if not, also check `error.name === "DeviceRemoved"`.

**Done when:** the TV's code imports `openPull` and `newPairingSecrets` from `src/sync-core`, the legacy build is still ES5, and a test opens `sync-core`'s test account (`testAccount.ts`).

### 2. `src/data/sync.ts` and the sync worker

The data side, with no UI:

- **What's kept:** `velio.sync` in `localStorage`, through `appStorage` (so `settingsCopy.ts` copies it, which is fine: it's the same TV):
  - `site` (`https://velio.tv` by default). While signed out, Settings → Velio account has a **Server** field for a self-hosted server (or `wrangler dev`): `cleanSite()` adds `https://` when there's no scheme, keeps a path (for a server behind a proxy), and goes back to velio.tv when the field is left empty. Signed in, the server can't change, as the keys belong to it;
  - `trust: DeviceTrust` (account, device id, the TV's box secret key, the owner's signing and box public keys);
  - `token` (the device token);
  - `view: DeviceView` (the last opened pull: its `rev`, profiles and lists) and when it was pulled.
- **Backups** (`backup.ts`) leave all of this out, and leave out synced sources too: a restored TV signs in again and pulls them.
- **Pulling:** `GET /v1/sync` with `If-None-Match: "<view.rev>"`, through the app's fetch (`src/polyfills/fetch.ts` for old TVs). 304: nothing to do. 200: hand the JSON, the trust and the previous view to the worker, which runs `openPull()` and answers the new view. 401: run "removed" (step 7). Network errors: keep the last view, and try again on the next timer.
- **The worker:** `src/data/sync.worker.ts`, a classic worker like `import.worker.ts`, in ES5 for old TVs. It holds no state; each call sends the trust, the pull and the previous view. Keep `openPull()`'s refusals (`ReadProblem`, `CryptoProblem`, a rev going back) as errors the Account page can show, not as sign-outs. Only `DeviceRemoved` and a 401 sign out.
- **One pull at a time:** a pull asked for while one runs waits for it, then runs once more.
- **Tests (Vitest):** pure functions against a mock server built from `sync-core`'s own server side (`pullFor()` on a state made with `changes.ts`), as VelioPlatform's `test/tv.ts` does: a first pull, a 304, a changed list, a list taken from the TV's profile, a pull with a lower rev refused, a wrong signature refused, 401.

**Done when:** tests pull, open and refuse as above, and the worker opens the test account on the test TV in under 1 s while the UI stays at 60 fps (this is Phase 0's remaining item 1; record it in VelioPlatform's Phase 0 results).

### 3. Settings → Account: signing in by QR code

A new entry in Settings (`src/pages/Settings.tsx`'s `PAGES`), `src/pages/settings/AccountPage.tsx`:

- **Signed out:** text saying what sync does in neutral words ("your own lists, typed once on a phone"), and **Sign in with a phone**.
- **Signing in:**
  1. Make the TV's box key pair (`newBoxKeyPair()`) and `newPairingSecrets()`.
  2. `POST /v1/pair` with `pairRequest(secrets, {format: 1, publicKey, name})`. The name is what the owner sees on the TVs page, such as "Samsung TV" plus the model, cut to 40 characters.
  3. Show the QR code for `pairingUrl(site, id, secrets)`, and the typed code `pairingCode(id, secrets)` (such as `K7QM-2XHF-9WRT`) with "or go to velio.tv/pair and type".
  4. Long-poll `GET /v1/pair/:id`. On `waiting`, ask again at once (the server already waited); if an answer comes back in under 3 s, wait before asking again, to stay under 20 a minute. On 410 or after `expiresAt`, offer to start again with a new code.
  5. On `done`: `openPairingPayload(kind, secrets, payload, myPublicKey)`, check `payload.device === deviceId`, keep the trust and token, forget the pairing secrets, and pull at once.
  - Leaving the page stops the poll. The pairing then expires on its own in 10 minutes.
- **Signed in:** the profiles this TV has (picture and name), the last pull and whether it worked, **Pull now**, and **Sign out**. Sign out asks first, sends `POST /v1/signout`, then (whatever it answered) forgets the keys, token and view, and removes the synced sources and their data. It says the owner can remove the TV at velio.tv to take it off the account.
- **The QR code:** an encoder that runs in ES5, such as `qrcode-generator` (check its size and that it's ES5), drawn into a canvas and shown as an image (check that the renderer takes a `data:` URL or a canvas). Error correction M at least; the URL is about 60 characters. Big enough to scan from a sofa: test with a phone at 3 m.
- **Voice guide:** the page reads the code out in groups when it's focused.

**Testing without velio.tv:** run the Worker with `wrangler dev` on the host (in VelioPlatform: `npm run build && npx wrangler dev --port 8787 --ip 0.0.0.0`) and point a dev build's `site` at `http://<dev machine>:8787` (address in `PRIVATE.md`). The phone half can't run over plain HTTP on a LAN address, as the session cookie is `__Host-` and `Secure`; do it in a desktop browser at `http://127.0.0.1:8787/pair` with the typed code instead. Emails in dev mode are at `/dev/outbox`.

**Done when:** the test TV signs in with the typed code against `wrangler dev`, and with the QR code against velio.tv from a real phone.

### 4. Applying synced lists

- `Source` gets `synced?: true` and `profiles?: string[]` (the profile ids that use it). `readSource()` keeps both.
- A new `library.applySynced(lists)` in `sourceManager.ts`: keeps every local source, replaces the synced ones with the view's lists (keeping their ids, so edits and favourites still match), imports those that are new or whose `changesData()` is true, and deletes the data of synced sources no profile on the TV can use any more. A list two profiles share is one source, imported once.
- Order in the list: local sources first as now, then synced ones in the account's order. (Or the other way; pick and say so.)
- **The source form** shows a synced list read-only: "Edited at velio.tv". Its on/off switch is hidden too, as `disabled` comes from the account.
- **The source manager pulls first:** at startup, when the app comes back into view, and on its 15-minute timer, it pulls before checking which sources are due.

**Done when:** VelioPlatform's Phase 3 check passes on the TV: **a TV signs in by QR with two of three profiles, and a list added on the web to one of them imports within 15 minutes.** Lists added on the TV itself stay as they were.

### 5. Profiles on the TV

- **When there are profiles:** only when signed in. A TV that isn't signed in has one implicit profile and behaves exactly as now.
- **The picker:** at startup when the TV has more than one profile, and from the side menu to switch. Each profile is its picture (`PROFILE_COLORS[profileColor(p)]` with `profileInitial(name)` in `PROFILE_LETTER_COLOR`) and its name. A profile with a PIN asks for it with the existing `PinPrompt` (`profilePinMatches()`). The last profile used is remembered per TV.
- **The lineup** is the current profile's lists plus the TV's own local lists (VelioPlatform PLAN.md "Open choices", 1: local lists are for every profile).
- **Per-profile data:** favourites and channel edits (`velio.channelEdits`), watched (`velio.watched`), reminders (`velio.reminders`), settings (`velio.settings`) and the last channel (`velio.lastChannel`) get a profile part in their key, such as `velio.watched@<profile id>`. Today's data becomes the first profile's when the TV first signs in. Decide which settings stay per TV (the clock format, scrolling speeds and track preferences are likely per TV; the start page and parental PIN per profile) and write the choice down.
- **A profile taken from the TV:** its data is deleted at the pull that drops it, and the picker opens if it was the current one.
- **Backups** keep working per TV: they hold the current profile's data, or all profiles', and say which.

**Done when:** **two profiles on one TV keep their own lineups and favourites across restarts**, and a PIN set on the web is asked for on the TV.

### 6. Live updates

`src/data/syncEvents.ts`, following `events.ts`'s header comment:

- Connect with `new WebSocket(eventsUrl(site), eventsProtocols(token))` when signed in and the app is in view; close when it's hidden.
- `rev N`: pull, unless the view is already at N.
- Send `ping` every 45 s.
- `removed`, or close 4401: pull to confirm. A 401 means sign out (step 7). Don't wait for `onclose` after `removed`; it can take seconds to come.
- Close 4409: another socket of this TV took over; don't reconnect.
- Any other close: reconnect after `reconnectDelay(attempt)`, and keep the 15-minute pull either way. The first `rev N` after reconnecting catches up.

**Done when:** **a change on the web starts the TV's import within seconds,** and the socket stays up for hours on the test TV (and on an old TV when there is one), reconnecting after the network drops.

### 7. Removed, reset, deleted or closed

A 401 from `/v1/sync`, or `DeviceRemoved` from `openPull()`, means the TV is no longer in the account: the owner removed it, reset or deleted the account, or the account was closed after a notice (VelioPlatform Phase 8). All look the same to the TV, on purpose.

- Forget the keys, token and view; remove the synced sources and their data, and the profiles' data; keep local sources.
- Show it once: "This TV was signed out of your Velio account", with Sign in again.
- New profile keys after the owner changes another TV need nothing here: `openPull()` takes them.

**Done when:** VelioPlatform's Phase 6 check holds on the TV: **a removed TV, or a TV a profile was taken from, can't read a new version; the others carry on.** Also check a closed account (VelioPlatform's `scripts/ops.mjs close` against `wrangler dev`) signs the TV out.

### 8. The full run

VelioPlatform's Phase 7 check, on the test TV against velio.tv: **sign up on the web, add a profile and a list from the test server, sign the TV in by QR, and play a synced channel.** Then:

- the voice guide on the Account page and the picker;
- every new text in every language file;
- no storage growth from pulls (the view is small, and written only when it changes);
- a pull's crypto never drops frames (check with `ui-perf`).

### 9. Phase 0's open items

1. The worker-based open under 1 s at 60 fps (step 2 covers it).
2. **Certificates on 2017 TVs:** velio.tv's certificate is Let's Encrypt ECDSA, ending at ISRG Root X2, which a Tizen 3 or webOS 3 TV very likely doesn't trust. Run the `sync` probe on such a TV when one is at hand, or compare their root lists. If it fails, the fix is on the server's side: choose Google Trust Services as velio.tv's certificate authority in Cloudflare.

## Open choices for the TV

1. **Copying `sync-core` or a git dependency** (step 1).
2. **Which settings are per profile** (step 5).
3. **Where synced lists sit** in the source list (step 4).
4. **Restoring a backup on a signed-in TV:** keep the synced sources and sign-in as they are (recommended), or sign out.

## Results (2026-11-10)

Steps 1 to 7 are built, with tests, and run end to end in Chromium 47 against the test server. Step 8 (the full run on the test TV against velio.tv) and step 9's certificate check are left.

**What was built:**

- **Step 1:** `scripts/sync-core/copy.mjs` copies `sync-core` (without `login.ts` and `export.ts`) into `src/sync-core/`; `pnpm check` runs it with `--check`. `newId()` in VelioPlatform no longer uses `replaceAll()`, which Chromium 38 lacks (VelioPlatform's checks pass). `instanceof` isn't relied on: errors cross the worker by name.
- **Step 2:** `src/data/sync.ts` (what's kept as `velio.sync`, one pull at a time, 304s with no writes, sign-out on 401 or `DeviceRemoved`), `sync.worker.ts` and `syncOpen.ts` (a worker per open). 15 tests against `scripts/test-streams/sync.ts`, a mock `/v1` built from `sync-core`'s server side.
- **Step 3:** `src/data/pairing.ts` (7 tests) and Settings → Velio account (`AccountPage.tsx`): the QR code (`qrcode-generator` 1.4.4, ES5, error correction M, a GIF `data:` URL, 480 px on a white frame), the typed code, which the voice guide reads out a character at a time in groups, the profiles, the last check, Check for changes, and Sign out (asks twice).
- **Step 4:** `Source.synced` and `profiles`; `library.applySynced()`; the TV's own sources come first, then the account's (open choice 3). Synced sources open read-only (`SyncedSourcePage.tsx`, "Edited at velio.tv") and have a "Velio" badge. Backups leave them out, and restoring a backup keeps them and the sign-in (open choice 4).
- **Step 5:** `src/data/profiles.ts` (7 tests). Per-profile keys are `velio.channelEdits`, `velio.watched`, `velio.reminders` and `velio.lastChannel`, as `key@<profile id>`. **The settings stay per TV** (open choice 2): language, clock, start page, scrolling, tracks and the parental PIN, as they're about the TV; a profile's own PIN is set at velio.tv. The TV's data so far is copied to the first profile at the first pull. The picker (`src/pages/Profiles.tsx`) opens at start when there's more than one profile, or one with a PIN; the profile in use is at the top of the side menu, and OK on it opens the picker (PLAN.md, "Profile in the menu").
- **Step 6:** `src/data/syncEvents.ts` (7 tests with a fake socket), connected while signed in and in view.
- **Step 7:** removal forgets the keys, the synced sources and every profile's data, keeps the TV's own, and shows "This TV was signed out of your Velio account" once (OK opens Settings).
- **Test server:** `pnpm test-streams` answers `/v1/` and `/v1/events` from the made-up account, with the owner's side as GET requests under `/sync/` (`scripts/test-streams/syncServer.mjs`). The `sync-signin` probe signs in, adds a list, sets a PIN and removes the TV through it.

**Chromium 47, legacy build** (`scripts/old-chrome/run.mjs` with the `sync-signin` probe): sign-in in 131 ms. The pull opened in the worker in 85–89 ms, or 231 ms with starting the worker. That's 15 frames in 266 ms, the worst 17 ms, so step 2's "under 1 s at 60 fps" holds on the oldest Tizen's browser. Choosing a profile showed only its lists, and favourites stayed per profile. A list added on the "web" was a source in 0.3 s through the socket, and a PIN set there arrived in 0.3 s. Removing the TV signed it out within a second, with the notice.

**The test TV** (modern build, against the test server, 2026-11-10): sign-in in 1.6 s. The first pull took 1.3 s in all; the open took 201 ms in the worker (652 ms with starting it), with 42 frames and the worst 20 ms, so the UI kept its 60 fps. The socket opened at once. A list added on the "web" was a source 1.5 s later and its import started at once. The picker opened at start and a profile was chosen with the remote. `webapis.productinfo` needs a privilege the app doesn't have ("Permission denied"), so the TV calls itself "Samsung TV" without its model.

**Left:**

- **QR sign-in from a phone, test TV (2026-11-10):** the user scanned the QR code and approved the TV on `/pair`, the test server's made-up copy of velio.tv's phone page; the TV signed in.

1. The test TV's visual check: the same probe (`./scripts/tv-probe/run.sh <tv-ip> sync-signin '{"step": "signin", "base": "http://<dev machine>:8090", "profiles": "Living room,Kids"}'`), then a look at the Account page, the QR code from a phone at 3 m, the picker and the PIN prompt.
2. Step 8 against velio.tv, and the socket kept up for hours.
3. Step 9: the certificate on a 2017 TV.
