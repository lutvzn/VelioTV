#!/usr/bin/env bash
#
# Builds and signs the app, installs it on a Samsung TV, and starts it:
#   ./scripts/deploy-tizen.sh <tv-ip>
#
# The TV must be in Developer Mode with this computer's IP set as the host.

set -euo pipefail

readonly APP_ID="VelioTVapp.Velio"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/tizen-env.sh"
[[ $# -eq 1 ]] || fail "usage: $0 <tv-ip>"
tizen_require_cli
tizen_require_sdb

target="$1:26101"
package_dir="$repo_root/dist/tizen-package"
bash "$repo_root/scripts/package-tizen.sh"
package="$(find "$package_dir" -maxdepth 1 -name '*.wgt' -print -quit)"
[[ -n "$package" ]] || fail "packaging didn't produce a .wgt file."

printf '\n==> Install on %s\n' "$target"
"$TIZEN_SDB" connect "$1" >/dev/null
tizen_cli install -s "$target" -n "$(basename "$package")" -- "$package_dir"

printf '\n==> Start\n'
tizen_cli run -s "$target" -p "$APP_ID"
