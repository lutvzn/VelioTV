# Notes for coding agents

VelioTV is an IPTV app built with SolidTV, for Samsung Tizen first and LG webOS last. `PLAN.md` holds the plan, the phase in progress and every device test result. Read it before starting work, and record new results there. Device addresses and IDs are in `PRIVATE.md` (git-ignored, local only); don't copy them into tracked files.

## Tools

- TV tooling lives in the `tv-dev` distrobox (`distrobox.ini`, set up by `scripts/setup-dev.sh`). Run TV commands with `distrobox enter tv-dev -- bash -lc '...'`. In a non-login shell, load Node first:
  `export FNM_DIR="$HOME/.local/share/fnm"; export PATH="$FNM_DIR:$PATH"; eval "$(fnm env --shell bash)"`
- pnpm is the only package manager. `pnpm check` runs format check (oxfmt), lint (oxlint, type-aware), type check (tsc) and tests (Vitest). Set `CI=1` to run the browser tests headless. Run it before calling work done, inside the box (the host has no Playwright WebKit).
- Deploy to the TV with `./scripts/deploy-tizen.sh <tv-ip>` inside the box. It builds, signs, installs and starts the app. The TV address is in `PRIVATE.md`.

## Testing on the TV

- On-TV tests are probes in `scripts/tv-probe/probes/`, run inside the installed app:
  `./scripts/tv-probe/run.sh <tv-ip> <probe> '<input-json>'`
  Each probe's header lists its input. Results come out as JSON, usually wrapped as `{"done": {...}}`.
- Keep a TV run to a minute or two. Before a longer one, say how long it will take, or shrink the input.
- The user checks anything visual on the TV themselves (alignment, smoothness, layout) and reports back. Ask them to look when a test is visual.
- `#/dev/video?url=<stream>` opens a developer page for video behind the UI.
- The oldest TVs supported are Tizen 3 (Chromium 47) and webOS 3 (Chromium 38), which run the ES5 legacy build; the test TV runs the modern one. Don't rely on Proxy or newer browser APIs without a fallback (`src/polyfills/`). `pnpm check:old-tvs` checks that the legacy build and workers are ES5 (CI and the deploy run it). To run the app in an old Chromium, get it with `./scripts/old-chrome/get.sh [snapshot]` (69 by default; 352221 is 47, 290027 is 38), build with `TARGET_DEVICE=common pnpm build`, start `pnpm test-streams`, then `node scripts/old-chrome/run.mjs <chrome>`. Inside the box `~` is the box's own home, so pass the chrome path that `get.sh` prints. Chromium 47 and 38 run only in the `old-chrome` distrobox (`distrobox assemble create --file distrobox.ini --name old-chrome`): add `OLD_CHROME_BOX=old-chrome` before `node`, from the host or the tv-dev box.
- The app's storage is capped at 80 MB on the TV, and deleted records under 64 KB keep their space (PLAN.md, Phase 8, step 2), so the guide is stored in blocks over 64 KB. Keep new records that are written often over that size, or few. If storage still fills up, deleting the app's database (`indexedDB.deleteDatabase("velio")` from a probe while the app holds no connection, or reinstalling) gives the space back; the sources then import again.
- Text the user sees goes through `$t()`/`$tn()` (`src/translate.ts`) with keys in every `src/lang/*.json`; a test checks each language has every English key. The TV's voice guide reads the focused node's text (`src/voiceGuide.ts`); a page that moves its own cursor gives its node `announce=""` and says what's under the cursor with `sayWhileFocused()`.

## Test data

- Use test data we make ourselves. `pnpm test-streams` serves labelled live test streams (`scripts/test-streams/`) on port 8090, plus made-up IPTV sources that play them: an M3U, an XMLTV guide and mock Xtream and Stalker logins (listed in its header comment and at `/`). The dev machine address the TV uses is in `PRIVATE.md`.
- Don't use public or provider IPTV playlists with copyrighted channels, and keep the user's own playlists out of the repo. Public guide (XMLTV) files with no streams in them are fine for parsing tests.

## Git and CI

- The repo is on the user's own Forgejo, branch `master`. CI is `.forgejo/workflows/ci.yml`.
- Don't query the Forgejo server; the user reports CI results.
- The user commits and pushes themselves. Don't commit unless asked. When asked for a commit name, suggest a short, plain title, such as "Add Samsung Phase 0 test tools and video-behind-UI support".
