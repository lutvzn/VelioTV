#!/usr/bin/env bash
#
# Runs a probe inside TiviPlayer on a Samsung TV, to test what the TV can do
# from the app's own context. Run it inside the tv-dev box, with the app
# installed (scripts/deploy-tizen.sh):
#
#   ./scripts/tv-probe/run.sh <tv-ip> <probe> [input-json]
#
# Probes are in scripts/tv-probe/probes/. Examples:
#   ./scripts/tv-probe/run.sh 10.0.1.139 avplay '{"index": "http://10.0.0.101:8090/"}'
#   ./scripts/tv-probe/run.sh 10.0.1.139 fetch '{"urls": ["https://example.com/"]}'
#
# The result is printed as JSON; progress goes to stderr. It restarts the app
# in debug mode, because the TV only opens its debug port when the app starts.

set -euo pipefail

[[ $# -ge 2 ]] || {
  sed -n '3,15p' "$0" >&2
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
sdb="$HOME/tizen-studio/tools/sdb"
local_port=9333

[[ -f "$probe" ]] || {
  echo "Error: no probe at $probe" >&2
  exit 1
}

export FNM_DIR="$HOME/.local/share/fnm"
export PATH="$FNM_DIR:$PATH"
eval "$(fnm env --shell bash)"

"$sdb" connect "$tv_ip" >/dev/null
# The debug command hangs if the app is already running.
timeout 15 "$sdb" -s "$target" shell 0 was_kill TiviPlayer >/dev/null || true
launch="$(timeout 40 "$sdb" -s "$target" shell 0 debug TiviPlayer.TiviPlayer 2>&1)"
debug_port="$(grep -o 'port: [0-9]*' <<<"$launch" | grep -o '[0-9]*' || true)"
[[ -n "$debug_port" ]] || {
  echo "Error: the app didn't start in debug mode: $launch" >&2
  exit 1
}

"$sdb" -s "$target" forward "tcp:$local_port" "tcp:$debug_port" >/dev/null
trap '"$sdb" -s "$target" forward --remove "tcp:$local_port" >/dev/null 2>&1 || true' EXIT
sleep 1
ws_url="$(curl -fsS "http://127.0.0.1:$local_port/json" | grep -o 'ws://[^"]*' | head -n 1)"

node "$(dirname "${BASH_SOURCE[0]}")/eval.mjs" "$ws_url" "$probe" "$input"
