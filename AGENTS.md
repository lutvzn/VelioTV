# Notes for coding agents

TiviPlayer is an IPTV app built with SolidTV, for Samsung Tizen first and LG webOS last. `PLAN.md` holds the plan, the phase in progress and every device test result. Read it before starting work, and record new results there. Device addresses and IDs are in `PRIVATE.md` (git-ignored, local only); don't copy them into tracked files.

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
- The app's storage is capped at 80 MB on the TV, and deleted data keeps its space for a while. If repeated imports run into `QuotaExceededError`, reinstall the app (`tizen uninstall`, then deploy) to reset it.

## Test data

- Use test data we make ourselves. `pnpm test-streams` serves labelled live test streams (`scripts/test-streams/`) on port 8090, plus made-up IPTV sources that play them: an M3U, an XMLTV guide and mock Xtream and Stalker logins (listed in its header comment and at `/`). The dev machine address the TV uses is in `PRIVATE.md`.
- Don't use public or provider IPTV playlists with copyrighted channels, and keep the user's own playlists out of the repo. Public guide (XMLTV) files with no streams in them are fine for parsing tests.

## Git and CI

- The repo is on the user's own Forgejo, branch `master`. CI is `.forgejo/workflows/ci.yml`.
- Don't query the Forgejo server; the user reports CI results.
- The user commits and pushes themselves. Don't commit unless asked. When asked for a commit name, suggest a short, plain title, such as "Add Samsung Phase 0 test tools and video-behind-UI support".
