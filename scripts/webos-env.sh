# Shared by the LG webOS scripts. LG's CLI (ares-package, ares-install,
# ares-launch, ...) comes from @webos-tools/cli, a dev dependency of the
# project (pnpm add -D @webos-tools/cli) or installed globally; the
# project's copy comes first. Each TV is set up once with ares-setup-device and ares-novacom --getkey
# (README, "LG webOS TV"); the CLI keeps that in ~/.webos.

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

webos_require_cli() {
  local tool bin
  bin="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/node_modules/.bin"
  [[ -d "$bin" ]] && PATH="$bin:$PATH"
  for tool in ares-package ares-install ares-launch; do
    command -v "$tool" >/dev/null 2>&1 ||
      fail "$tool not found. Install LG's CLI with: pnpm add -D @webos-tools/cli"
  done
}
