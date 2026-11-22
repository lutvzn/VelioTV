#!/usr/bin/env bash
#
# Builds and packages the app, installs it on an LG TV, and starts it:
#   ./scripts/deploy-lg.sh <device-name>
#
# <device-name> is the name given to the TV with ares-setup-device; the TV
# must be in Developer Mode with its key fetched (ares-novacom --getkey).

set -euo pipefail

readonly APP_ID="tv.velio.app"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/webos-env.sh"
[[ $# -eq 1 ]] || fail "usage: $0 <device-name>"
webos_require_cli
device="$1"

package_dir="$repo_root/dist/lg-package"
bash "$repo_root/scripts/package-lg.sh"
package="$(find "$package_dir" -maxdepth 1 -name '*.ipk' -print -quit)"
[[ -n "$package" ]] || fail "packaging didn't produce an .ipk file."

printf '\n==> Install on %s\n' "$device"
ares-install -d "$device" "$package"

printf '\n==> Start\n'
ares-launch -d "$device" "$APP_ID"
