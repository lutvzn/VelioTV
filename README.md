# VelioTV

A media center for TVs, built with SolidTV, targeting Samsung Tizen first and LG webOS later. It plays your own media: live channels and guides from M3U or Xtream Codes sources you have the rights to, films and series from your own media server (Jellyfin or Emby, planned), and streams from Stremio add-ons. Velio comes with no channels or content of its own.

## Native Linux development

Use Node.js **24 or newer** and **pnpm 12.14.0**. No distrobox, TV SDK, or
signing certificates are required for browser development.

```sh
bash scripts/setup-dev.sh
pnpm start
CI=1 pnpm check
pnpm build
```

Once pnpm is available, `pnpm run setup` also runs the setup script. Setup installs
locked dependencies and Playwright Chromium. If pnpm is absent, it uses
Corepack to enable **only pnpm** in `~/.local/bin`; if necessary, run
`export PATH="$HOME/.local/bin:$PATH"` in your shell. It does not edit shell
startup files, install Node, install webOS globals, or install SDKs.

Chromium can require host shared libraries. Install packages reported by
Playwright using your host package manager. On supported distributions,
`bash scripts/setup-dev.sh --with-deps` explicitly allows Playwright's system
dependency installer (which may use sudo); normal setup never does this.
On Fedora, use native Fedora packages rather than assuming Playwright's
Debian/Ubuntu dependency installer supports the host.

`pnpm test-streams` needs `ffmpeg` on PATH: for example, install `ffmpeg-free`
with Fedora's `dnf` or `rpm-ostree` (reboot after layering), or `ffmpeg` with
Debian/Ubuntu's `apt`. Some codecs require additional multimedia repositories.
Chromium 38/47 compatibility runs still need their legacy runtime; the native
Playwright browser is not a replacement for testing those old engines.

## Build settings

The git-ignored `.env` at the project root can hold values the build puts in
the app (and nothing else from it):

- `TMDB_API_KEY`: matches titles through TMDB. Without it, the app uses Cinemeta only.
- `NUVIO_BACKEND_URL` and `NUVIO_PUBLISHABLE_KEY`: Nuvio's own server, where
  TVs sign in by default. Without them, only self-hosted Velio servers work.

## Samsung TV build, signing, and deployment

```sh
TARGET_DEVICE=tizen pnpm build
pnpm package:tizen
pnpm deploy:tizen <tv-ip>
pnpm tv-probe <tv-ip> <probe> '<input-json>'
```

Packaging/deployment use the `TizenDev` signing profile (override with
`TIZEN_PROFILE`). Enable Developer Mode on the TV and set this computer's IP
as its development host before deployment.

Imported private tools live in `.local/tizen-studio`, SDK data in
`.local/tizen-studio-data`, and signing files in `.local/certificates`.
**Keep all of `.local/` out of Git**, including certificates, passwords and SDK
metadata. These files are optional for browser work. `pnpm tizen` wraps the
imported SDK and relocates its metadata for the current checkout.
`TIZEN_SDK` overrides the SDK location; an existing `~/tizen-studio` can also
be used when no project-local SDK is present.

To import existing author/distributor `.p12` files, run the following in Bash
from the project root, entering the actual filenames and their original
passwords when prompted (passwords are not saved in shell history):

```bash
find .local/certificates -type f -name '*.p12'
read -r -p 'Author .p12 path: ' author_file
read -r -p 'Distributor .p12 path: ' distributor_file
read -r -s -p 'Original author password: ' author_password; printf '\n'
read -r -s -p 'Original distributor password: ' distributor_password; printf '\n'
pnpm tizen security-profiles add -f -A -n TizenDev \
  -a "$(realpath "$author_file")" -p "$author_password" \
  -d "$(realpath "$distributor_file")" -dp "$distributor_password"
unset author_password distributor_password
```

The CLI stores passwords in the host's login keyring, keyed by certificate
path; the profile's `.pwd` paths are keyring identifiers, not missing files.
Re-register after moving the checkout or switching machines. Password
arguments can briefly be visible to local process inspection. Samsung
distributor certificates must authorize the target TV.

## LG webOS TV build and deployment

The LG port is in progress (PLAN.md, Phase 9). It needs LG's CLI, as a dev
dependency of the project (or installed globally with `-g`):

```sh
pnpm add -D @webos-tools/cli
```

The `pnpm package:lg` and `pnpm deploy:lg` scripts find the project's copy
themselves; run the other `ares-*` commands below through `pnpm exec`.

On the TV, sign in with an LG developer account, install the **Developer
Mode** app from the LG Content Store, turn Dev Mode on (the TV restarts) and
turn on Key Server. Dev Mode lasts a limited time; extend it in that app. Then
set up the TV once, from this computer:

```sh
pnpm exec ares-setup-device -a <name> -i "host=<tv-ip>" -i "port=9922" -i "username=prisoner"
pnpm exec ares-novacom --device <name> --getkey   # passphrase shown in the Developer Mode app
```

```sh
pnpm package:lg
pnpm deploy:lg <name>
pnpm exec ares-inspect -d <name> --app tv.velio.app --open   # Web Inspector for the running app
```

No signing certificate is needed for Developer Mode installs.
