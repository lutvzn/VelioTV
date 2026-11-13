#!/usr/bin/env bash
# Set up browser development on the Linux host, without changing shell startup files.
set -euo pipefail

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

with_deps=false
for arg in "$@"; do
  case "$arg" in
    --with-deps) with_deps=true ;;
    -h | --help)
      cat <<'EOF'
Usage: scripts/setup-dev.sh [--with-deps]

Requires Linux and Node.js >=24. Installs locked pnpm dependencies and
Playwright Chromium. If pnpm is missing, uses Corepack to enable only pnpm
in ~/.local/bin. Does not modify shell startup files.

--with-deps  Explicitly allow Playwright to install system dependencies
             on supported distributions (may invoke sudo).

Without --with-deps no privileged package installation is performed.
SDKs and certificates are not needed for browser development.
EOF
      exit 0
      ;;
    *) fail "unknown option: $arg (see --help)" ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || fail "this setup supports Linux hosts."
command -v node >/dev/null 2>&1 || fail "install Node.js >=24, then rerun this script."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' ||
  fail "Node.js >=24 is required; current version: $(node --version)."

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! command -v pnpm >/dev/null 2>&1; then
  if [[ -x "$HOME/.local/bin/pnpm" ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    command -v corepack >/dev/null 2>&1 ||
      fail "pnpm is missing. Use a Node 24 installation with Corepack, or install pnpm 12.14.0, then rerun."
    mkdir -p "$HOME/.local/bin"
    corepack enable --install-directory "$HOME/.local/bin" pnpm
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

printf '\n==> Installing locked project dependencies\n'
pnpm install --frozen-lockfile

printf '\n==> Installing Playwright Chromium\n'
if [[ "$with_deps" == true ]]; then
  pnpm exec playwright install --with-deps chromium
else
  pnpm exec playwright install chromium
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  cat >&2 <<'EOF'

ffmpeg is missing; test-streams needs it. Install it with your host's package
manager, for example:
  Fedora:        sudo dnf install ffmpeg-free
  Ubuntu/Debian: sudo apt install ffmpeg
On an image-based Fedora host, layer ffmpeg-free with rpm-ostree install
and reboot into the new deployment. Additional codecs may need your distro's
multimedia repositories.
EOF
fi

printf '\nSetup complete. Node %s; pnpm %s.\n' "$(node --version)" "$(pnpm --version)"
case ":$PATH:" in
  *":$HOME/.local/bin:"*)
    # PATH above applies only to this process; do not edit the user's shell files.
    printf 'If pnpm is not on your shell PATH, run: export PATH="$HOME/.local/bin:$PATH"\n'
    ;;
esac
cat <<'EOF'
Run pnpm start, CI=1 pnpm check, or pnpm build.
Chromium may still need host shared libraries. Install the packages reported
by Playwright using your host package manager; --with-deps is opt-in and
only suitable on distributions supported by Playwright.
EOF
