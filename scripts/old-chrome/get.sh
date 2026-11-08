#!/usr/bin/env bash
#
# Downloads a Chromium snapshot build as old as the oldest TVs' browsers, for
# scripts/old-chrome/run.mjs (PLAN.md, Phase 8, step 4). By default Chromium
# 69 (Tizen 5.5); 561733 is Chromium 68 (webOS 5). About 100 MB each, kept in
# ~/.cache/tiviplayer, and printed: the path of its chrome binary.
#
#   ./scripts/old-chrome/get.sh [position]
#
# Inside the tv-dev box, $HOME is the box's own home, so the copy lands there.

set -euo pipefail

readonly POSITION="${1:-576753}"
readonly DIR="$HOME/.cache/tiviplayer/chromium-$POSITION"
readonly CHROME="$DIR/chrome-linux/chrome"

if [[ ! -x "$CHROME" ]]; then
  mkdir -p "$DIR"
  curl -fL --progress-bar -o "$DIR/chrome-linux.zip" \
    "https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/$POSITION/chrome-linux.zip"
  unzip -q -o "$DIR/chrome-linux.zip" -d "$DIR"
  rm "$DIR/chrome-linux.zip"
fi
"$CHROME" --version >&2
echo "$CHROME"
