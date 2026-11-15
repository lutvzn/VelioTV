#!/usr/bin/env bash
#
# Runs a probe inside Velio on a Samsung TV, to test what the TV can do
# from the app's own context, with the app installed (scripts/deploy-tizen.sh):
#
#   ./scripts/tv-probe/run.sh <tv-ip> <probe> [input-json]
#
# Probes are in scripts/tv-probe/probes/. Examples:
#   ./scripts/tv-probe/run.sh <tv-ip> avplay '{"index": "http://<dev-ip>:8090/"}'
#   ./scripts/tv-probe/run.sh <tv-ip> fetch '{"urls": ["https://example.com/"]}'
#
# The result is printed as JSON; progress goes to stderr. It restarts the app
# in debug mode, because the TV only opens its debug port when the app starts.
# A probe is stopped after 15 minutes; set PROBE_TIMEOUT (in seconds) for a
# longer one. Set PROBE_PROFILE to a folder to save CPU profiles of the
# app's workers during the probe there (eval.mjs). Set PROBE_CONSOLE=1 to
# print the app's errors, warnings and uncaught exceptions from its start.

set -euo pipefail

[[ $# -ge 2 ]] || {
  sed -n '3,18p' "$0" >&2
  exit 1
}

tv_ip="$1"
# A probe name from probes/, or the path to any probe file.
if [[ -f "$2" ]]; then
  probe="$(realpath "$2")"
else
  probe="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/probes/$2.js"
fi
input="${3:-"{}"}"
target="$tv_ip:26101"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tizen-env.sh"
tizen_require_sdb
sdb="$TIZEN_SDB"
local_port=9333

[[ -f "$probe" ]] || {
  echo "Error: no probe at $probe" >&2
  exit 1
}

for tool in node curl timeout; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required to run TV probes."
done

"$sdb" connect "$tv_ip" >/dev/null
# The debug command hangs if the app is already running.
timeout 15 "$sdb" -s "$target" shell 0 was_kill VelioTVapp >/dev/null || true
# A start right after the kill has sometimes read the app's localStorage as
# empty or old, and lost what was written then (PLAN.md, Phase 6), so the
# killed app gets a moment to let go of it. KILL_WAIT (seconds) changes it,
# for testing that (the `storage-kill` probe).
sleep "${KILL_WAIT:-3}"
launch="$(timeout 40 "$sdb" -s "$target" shell 0 debug VelioTVapp.Velio 2>&1)"
debug_port="$(grep -o 'port: [0-9]*' <<<"$launch" | grep -o '[0-9]*' || true)"
[[ -n "$debug_port" ]] || {
  echo "Error: the app didn't start in debug mode: $launch" >&2
  exit 1
}

"$sdb" -s "$target" forward "tcp:$local_port" "tcp:$debug_port" >/dev/null
trap '"$sdb" -s "$target" forward --remove "tcp:$local_port" >/dev/null 2>&1 || true' EXIT
sleep 1
ws_url="$(curl -fsS "http://127.0.0.1:$local_port/json" | grep -o 'ws://[^"]*' | head -n 1)"

node "$(dirname "${BASH_SOURCE[0]}")/eval.mjs" "$ws_url" "$probe" "$input" "${PROBE_TIMEOUT:-900}"
