#!/usr/bin/env bash
# Build an ES5-compatible LG webOS app and package it as an .ipk.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/webos-env.sh"
webos_require_cli
for tool in node pnpm; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required to package the app."
done

build_dir="$repo_root/dist/lg"
package_dir="$repo_root/dist/lg-package"
cd "$repo_root"
printf '\n==> Build\n'
rm -rf "$build_dir"
TARGET_DEVICE=lg pnpm build
node scripts/check-old-tvs.mjs "$build_dir"
cp devices/lg/appinfo.json "$build_dir/"
# The TV scales these; store-sized icons come with the store build.
cp public/assets/solid.png "$build_dir/icon.png"
cp public/assets/solid.png "$build_dir/largeIcon.png"
# Source maps would only make the package bigger.
find "$build_dir" -name '*.map' -delete

printf '\n==> Package\n'
rm -rf "$package_dir"
mkdir -p "$package_dir"
ares-package --no-minify -o "$package_dir" "$build_dir"
package="$(find "$package_dir" -maxdepth 1 -name '*.ipk' -print -quit)"
[[ -n "$package" ]] || fail "packaging didn't produce an .ipk file."
printf '\nPackage: %s\n' "$package"
