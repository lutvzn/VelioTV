#!/usr/bin/env bash
#
# Starts an old Chromium inside the old-chrome distrobox (distrobox.ini), for
# scripts/old-chrome/run.mjs, which runs this when OLD_CHROME_BOX is set:
#
#   in-box.sh <chrome> [flags...]
#
# Chromium 47 and 38 have no headless mode, so the browser draws on its own
# Xvfb screen. Chromium 38 wants libudev.so.0, which Ubuntu 18.04 no longer
# has; libudev.so.1 stands in, as it did for Chrome then. The browser stops
# when run.mjs closes its tab or removes the profile folder (--user-data-dir).

set -euo pipefail

[[ "${CONTAINER_ID:-}" == "old-chrome" ]] ||
  { echo "Error: this runs inside the old-chrome box (distrobox enter old-chrome)." >&2; exit 1; }

# A new box has no font cache; the browser would build it, busy, for minutes.
if [[ ! -d "$HOME/.cache/fontconfig" ]]; then
  echo "Building the box's font cache, once..." >&2
  fc-cache
fi

work="$(mktemp -d)"
libs="$work/lib"
mkdir -p "$libs"
ln -s "$(ldconfig -p | awk '/libudev\.so\.1 .*x86-64/ { print $NF; exit }')" "$libs/libudev.so.0"

Xvfb -displayfd 3 -screen 0 1920x1080x24 -nolisten tcp 3>"$work/display" 2>/dev/null &
xvfb=$!
for _ in $(seq 50); do [[ -s "$work/display" ]] && break; sleep 0.1; done
[[ -s "$work/display" ]] || { echo "Error: Xvfb didn't start." >&2; exit 1; }

DISPLAY=":$(cat "$work/display")" LD_LIBRARY_PATH="$libs" "$@" &
browser=$!
cleanup() {
  kill "$browser" "$xvfb" 2>/dev/null || true
  wait "$xvfb" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# The box's input doesn't reach here, so run.mjs ending shows as its profile going.
profile=""
for flag in "$@"; do [[ "$flag" == --user-data-dir=* ]] && profile="${flag#--user-data-dir=}"; done
while kill -0 "$browser" 2>/dev/null; do
  [[ -z "$profile" || -d "$profile" ]] || break
  sleep 1
done
