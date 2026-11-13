#!/usr/bin/env bash
# Build an ES5-compatible Samsung TV widget and sign it with a local profile.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/tizen-env.sh"
tizen_require_cli
for tool in node pnpm; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required to package the app."
done
profile="${TIZEN_PROFILE:-TizenDev}"
tizen_require_profile "$profile"

build_dir="$repo_root/dist/tizen"
package_dir="$repo_root/dist/tizen-package"
cd "$repo_root"
printf '\n==> Build\n'
rm -rf "$build_dir"
TARGET_DEVICE=tizen pnpm build
node scripts/check-old-tvs.mjs "$build_dir"
cp devices/tizen/config.xml "$build_dir/"
cp public/assets/solid.png "$build_dir/icon.png"
# Source maps would only make the package bigger.
find "$build_dir" -name '*.map' -delete

printf '\n==> Sign with profile %s\n' "$profile"
rm -rf "$package_dir"
mkdir -p "$package_dir"
tizen_cli package -t wgt -s "$profile" -o "$package_dir" -- "$build_dir"
package="$(find "$package_dir" -maxdepth 1 -name '*.wgt' -print -quit)"
[[ -n "$package" ]] || fail "packaging didn't produce a .wgt file."
printf '\nPackage: %s\n' "$package"
