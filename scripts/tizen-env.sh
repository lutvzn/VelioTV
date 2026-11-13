#!/usr/bin/env bash
# Shared host SDK selection; source from the Tizen entry points.
TIZEN_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

if [[ -n "${TIZEN_SDK:-}" ]]; then
  [[ -d "$TIZEN_SDK" ]] || fail "TIZEN_SDK is not a directory: $TIZEN_SDK"
elif [[ -d "$TIZEN_REPO_ROOT/.local/tizen-studio" ]]; then
  TIZEN_SDK="$TIZEN_REPO_ROOT/.local/tizen-studio"
else
  TIZEN_SDK="$HOME/tizen-studio"
fi
[[ -d "$TIZEN_SDK" ]] || fail "install the Samsung SDK in .local/tizen-studio, or set TIZEN_SDK."
TIZEN_SDK="$(cd "$TIZEN_SDK" && pwd -P)"
export TIZEN_SDK
TIZEN_SDB="$TIZEN_SDK/tools/sdb"
TIZEN_CLI="$TIZEN_SDK/tools/ide/bin/tizen"
TIZEN_DATA="$TIZEN_REPO_ROOT/.local/tizen-studio-data"
TIZEN_PROFILES="$TIZEN_DATA/profile/profiles.xml"

tizen_require_sdb() {
  [[ -x "$TIZEN_SDB" ]] || fail "Samsung sdb is missing: $TIZEN_SDB"
}

tizen_require_cli() {
  [[ -x "$TIZEN_CLI" ]] || fail "the Tizen CLI is missing: $TIZEN_CLI"
  [[ -x "$TIZEN_SDK/jdk/bin/java" ]] || fail "the SDK bundled JDK is missing: $TIZEN_SDK/jdk/bin/java"
  mkdir -p "$TIZEN_DATA/profile"
  # The launcher reads absolute sdk.info paths, including a possible JDK_PATH.
  # Only this SDK's runtime metadata changes; never the user's global profiles.
  local metadata
  metadata="$(printf 'TIZEN_SDK_INSTALLED_PATH=%s\nTIZEN_SDK_DATA_PATH=%s\nJDK_PATH=%s' "$TIZEN_SDK" "$TIZEN_DATA" "$TIZEN_SDK/jdk")"
  if [[ ! -f "$TIZEN_SDK/sdk.info" ]] || [[ "$(cat "$TIZEN_SDK/sdk.info")" != "$metadata" ]]; then
    printf '%s\n' "$metadata" > "$TIZEN_SDK/sdk.info"
  fi
  # cli-config without --global writes SDK/tools/.tizen-cli-config.
  # profiles.path takes precedence over default.profiles.path and global defaults.
  "$TIZEN_CLI" cli-config "profiles.path=$TIZEN_PROFILES" >/dev/null
}

tizen_cli() {
  "$TIZEN_CLI" "$@"
}

tizen_require_profile() {
  [[ -f "$TIZEN_PROFILES" ]] || fail "register profile '$1' with pnpm tizen security-profiles add using the original .local/certificates P12 files and passwords (see README)."
  # Check only paths and profile names, never print profile contents or passwords.
  node --input-type=module - "$TIZEN_PROFILES" "$1" "$TIZEN_REPO_ROOT/.local/certificates" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [file, name, certificates] = process.argv.slice(2);
const decode = value => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attributes = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)]));
const xml = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const profile = [...xml.matchAll(/<profile\s+([^>]*)>([\s\S]*?)<\/profile>/g)].find(([, attrs]) => attributes(attrs).name === name);
const items = profile ? [...profile[2].matchAll(/<profileitem\s+([^>]*?)\/>/g)].map(([, attrs]) => attributes(attrs)) : [];
const keys = items.filter(item => item.key);
if (!profile || !keys.some(item => item.distributor === '0') || !keys.some(item => item.distributor === '1') || keys.some(item => !path.isAbsolute(item.key) || !item.key.startsWith(certificates + path.sep) || !fs.existsSync(item.key) || ['ca', 'rootca'].some(key => item[key] && !fs.existsSync(item[key])))) {
  console.error(`Error: profile '${name}' is missing or references certificates outside this checkout. Re-register with pnpm tizen security-profiles add using this checkout's original .local/certificates P12 files and original passwords (see README).`);
  process.exit(1);
}
NODE
}
