#!/usr/bin/env bash
#
# Builds the app for Samsung TVs, signs it with the active certificate
# profile, installs it on a TV and starts it. Run it inside the tv-dev box:
#
#   ./scripts/deploy-tizen.sh <tv-ip>
#
# The TV must be in Developer Mode with this computer's IP set as the host.

set -euo pipefail

readonly APP_ID="TiviPlayer.TiviPlayer"
readonly PROFILE="${TIZEN_PROFILE:-TizenDev}"
readonly TOOLS="$HOME/tizen-studio/tools"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail "usage: $0 <tv-ip>"
[[ -x "$TOOLS/ide/bin/tizen" ]] ||
  fail "the Tizen CLI isn't installed. Run this inside the tv-dev box, after scripts/setup-dev.sh."

target="$1:26101"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$repo_root/dist/tizen"
package_dir="$repo_root/dist/tizen-package"

cd "$repo_root"

printf '\n==> Build\n'
rm -rf "$build_dir"
TARGET_DEVICE=tizen pnpm build
cp devices/tizen/config.xml "$build_dir/"
cp public/assets/solid.png "$build_dir/icon.png"
# Source maps would only make the package bigger.
find "$build_dir" -name '*.map' -delete

printf '\n==> Sign with profile %s\n' "$PROFILE"
rm -rf "$package_dir"
mkdir -p "$package_dir"
"$TOOLS/ide/bin/tizen" package -t wgt -s "$PROFILE" -o "$package_dir" -- "$build_dir"
package="$(find "$package_dir" -maxdepth 1 -name '*.wgt' -print -quit)"
[[ -n "$package" ]] || fail "packaging didn't produce a .wgt file."

printf '\n==> Install on %s\n' "$target"
"$TOOLS/sdb" connect "$1" >/dev/null
"$TOOLS/ide/bin/tizen" install -s "$target" -n "$(basename "$package")" -- "$package_dir"

printf '\n==> Start\n'
"$TOOLS/ide/bin/tizen" run -s "$target" -p "$APP_ID"
