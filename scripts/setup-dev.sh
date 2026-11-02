#!/usr/bin/env bash
#
# Sets up the TV development tools inside the tv-dev distrobox.
# Safe to re-run: finished steps are skipped.
#
# From the host, first create and enter the box:
#   distrobox assemble create --file distrobox.ini
#   distrobox enter tv-dev
#
# Then, inside the box:
#   ./scripts/setup-dev.sh [--accept-tizen-license]
#
# This script refuses to run on the host, or in any other container.

set -euo pipefail

readonly BOX_NAME="tv-dev"
readonly NODE_MAJOR="24"
readonly TIZEN_VERSION="6.1"
readonly TIZEN_INSTALLER="web-cli_Tizen_Studio_${TIZEN_VERSION}_ubuntu-64.bin"
readonly TIZEN_URL="https://download.tizen.org/sdk/Installer/tizen-studio_${TIZEN_VERSION}/${TIZEN_INSTALLER}"
readonly TIZEN_INSTALLER_SIZE="280379318"
# The Samsung certificate tools come in two parts:
#   - cert-add-on, the Samsung Certificate Extension, which the package manager
#     installs (about 210 MB with its dependencies).
#   - certificate-manager-product, the Certificate Manager app. The package
#     manager only installs it through bundles such as "Certificate-Manager",
#     and every one of those also pulls in BASELINE-COMMON, about 1.5 GB of
#     Visual Studio and C# tools for every Tizen version. So this script
#     downloads the app's zip directly instead.
readonly TIZEN_REPO="http://download.tizen.org/sdk/tizenstudio/official"
readonly CERT_ADDON_PACKAGE="cert-add-on"
readonly CERT_MANAGER_ZIP="certificate-manager-product_1.3.11_ubuntu-64.zip"
readonly CERT_MANAGER_SHA256="b46409228a831637cecf084815af5150de710e481ec30dbc1e1cb8d8a09eba5c"
readonly CERT_PLUGIN_BUNDLE="org.tizen.common.cert,1.0.0.202510211036,plugins/org.tizen.common.cert_1.0.0.202510211036.jar,4,false"
readonly BASHRC_START="# >>> tv-dev setup >>>"
readonly BASHRC_END="# <<< tv-dev setup <<<"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$1"
}

# Every check must pass, because this script edits ~/.bashrc and installs
# global tools. In a distrobox that shares the host's home, those changes
# would land on the host.
require_box() {
  local hint="Enter the box first: distrobox enter ${BOX_NAME}"

  [[ -f /run/.containerenv ]] ||
    fail "this script only runs inside the ${BOX_NAME} distrobox, and this looks like the host. ${hint}"
  [[ "${CONTAINER_ID:-}" == "$BOX_NAME" ]] ||
    fail "this container is '${CONTAINER_ID:-unknown}', not '${BOX_NAME}'. ${hint}"
  [[ "$(id -u)" -ne 0 ]] ||
    fail "run this as your normal user, not root."
  [[ -n "${DISTROBOX_HOST_HOME:-}" && "$HOME" != "$DISTROBOX_HOST_HOME" ]] ||
    fail "this box shares your host's home, so changes would reach the host. Recreate it from distrobox.ini."
}

parse_args() {
  ACCEPT_TIZEN_LICENSE=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --accept-tizen-license) ACCEPT_TIZEN_LICENSE=true ;;
      -h | --help)
        printf 'Usage: %s [--accept-tizen-license]\n' "$0"
        exit 0
        ;;
      *) fail "unknown option: $1" ;;
    esac
    shift
  done
}

install_apt_packages() {
  step "System packages"

  local packages=(aria2 ca-certificates curl ffmpeg fonts-dejavu-core git gnome-keyring libsecret-1-0 openjdk-17-jre unzip)
  local missing=()
  local package

  for package in "${packages[@]}"; do
    dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package")
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "Already installed."
    return
  fi

  sudo apt-get update
  sudo apt-get install -y "${missing[@]}"
}

# The box inherits the host's environment, including FNM_DIR. Without this
# override, fnm installs Node into the host's fnm and changes its default.
configure_shell() {
  step "Shell configuration"

  local bashrc="$HOME/.bashrc"
  touch "$bashrc"

  if grep -qxF "$BASHRC_START" "$bashrc"; then
    echo "Already configured."
    return
  fi

  cat >>"$bashrc" <<EOF

$BASHRC_START
export FNM_DIR="\$HOME/.local/share/fnm"
export PATH="\$HOME/tizen-studio/tools:\$HOME/tizen-studio/tools/ide/bin:\$FNM_DIR:\$PATH"
eval "\$(fnm env --shell bash)"
$BASHRC_END
EOF
}

install_node() {
  step "Node ${NODE_MAJOR} and pnpm"

  export FNM_DIR="$HOME/.local/share/fnm"
  export PATH="$FNM_DIR:$PATH"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  if [[ ! -x "$FNM_DIR/fnm" ]]; then
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "$FNM_DIR" --skip-shell
  fi

  eval "$(fnm env --shell bash)"
  fnm install "$NODE_MAJOR"
  fnm default "$NODE_MAJOR"
  fnm use "$NODE_MAJOR"
  corepack enable
  hash -r
}

install_webos_cli() {
  step "webOS CLI"

  if [[ -x "$(npm prefix -g)/bin/ares-setup-device" ]]; then
    echo "Already installed."
    return
  fi

  npm install -g @webos-tools/cli
  hash -r
}

confirm_tizen_license() {
  if [[ "$ACCEPT_TIZEN_LICENSE" == true ]]; then
    return
  fi

  [[ -t 0 ]] ||
    fail "the Tizen tools need license acceptance. Re-run with --accept-tizen-license if you accept it."

  local reply
  echo "The Tizen CLI and certificate tools require accepting Samsung's license terms:"
  echo "  https://developer.samsung.com/smarttv/develop/tools/tizen-studio.html"
  read -r -p "Do you accept them? [y/N] " reply
  [[ "$reply" == [yY] || "$reply" == [yY][eE][sS] ]] ||
    fail "license not accepted, so the Tizen tools were not installed."
}

# download.tizen.org is very slow on a single connection (about 130 KB/s), so
# this uses parallel connections.
fast_download() {
  local url="$1" directory="$2" name="$3"

  aria2c --continue=true --split=16 --max-connection-per-server=16 --min-split-size=1M \
    --console-log-level=warn --summary-interval=0 --dir="$directory" --out="$name" "$url"
}

download_tizen_installer() {
  local directory="$1"

  fast_download "$TIZEN_URL" "$directory" "$TIZEN_INSTALLER"

  local size
  size="$(stat -c %s "$directory/$TIZEN_INSTALLER")"
  [[ "$size" == "$TIZEN_INSTALLER_SIZE" ]] ||
    fail "the Tizen installer is ${size} bytes, expected ${TIZEN_INSTALLER_SIZE}. Delete it from ${directory} and re-run."
}

install_tizen() {
  step "Tizen CLI"

  local tizen_dir="$HOME/tizen-studio"
  local state_dir="$HOME/.local/state/tv-dev"
  local packages_stamp="$state_dir/tizen-packages-installed"

  if [[ -x "$tizen_dir/tools/sdb" && -f "$packages_stamp" ]]; then
    echo "Already installed."
    return
  fi

  confirm_tizen_license

  if [[ ! -x "$tizen_dir/tools/sdb" ]]; then
    local cache_dir="$HOME/.cache/tv-dev"
    mkdir -p "$cache_dir"
    download_tizen_installer "$cache_dir"
    chmod +x "$cache_dir/$TIZEN_INSTALLER"
    "$cache_dir/$TIZEN_INSTALLER" --accept-license "$tizen_dir"
    rm -f "$cache_dir/$TIZEN_INSTALLER"
  fi

  echo "Installing the Samsung Certificate Extension. The package server is slow, so this can take a few minutes."
  "$tizen_dir/package-manager/package-manager-cli.bin" install --accept-license "$CERT_ADDON_PACKAGE" </dev/null

  install_certificate_manager "$tizen_dir"

  mkdir -p "$state_dir"
  touch "$packages_stamp"
}

# Its install.sh only adds a desktop menu entry, so copying the files is the
# whole install. The Samsung plugin isn't in the app's bundle list, so it is
# added there.
install_certificate_manager() {
  local tizen_dir="$1"
  local app_dir="$tizen_dir/tools/certificate-manager"
  local bundles="$app_dir/configuration/org.eclipse.equinox.simpleconfigurator/bundles.info"

  echo "Installing Certificate Manager."

  if [[ ! -x "$app_dir/certificate-manager" ]]; then
    local work_dir
    work_dir="$(mktemp -d)"
    fast_download "$TIZEN_REPO/binary/$CERT_MANAGER_ZIP" "$work_dir" "$CERT_MANAGER_ZIP"
    echo "$CERT_MANAGER_SHA256  $work_dir/$CERT_MANAGER_ZIP" | sha256sum --check --quiet ||
      fail "the Certificate Manager download doesn't match its checksum."
    unzip -q "$work_dir/$CERT_MANAGER_ZIP" 'data/*' -d "$work_dir/package"
    mkdir -p "$app_dir"
    cp -a "$work_dir/package/data/tools/certificate-manager/." "$app_dir/"
    rm -rf "$work_dir"
  fi

  grep -qxF "$CERT_PLUGIN_BUNDLE" "$bundles" || echo "$CERT_PLUGIN_BUNDLE" >>"$bundles"
}

install_project_dependencies() {
  step "Project dependencies"

  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$repo_root"

  pnpm install --frozen-lockfile
  pnpm exec playwright install --with-deps webkit
}

print_summary() {
  step "Done"

  export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"
  printf 'node   %s\n' "$(node -v)"
  printf 'pnpm   %s\n' "$(pnpm -v)"
  printf 'ares   %s\n' "$(ares-setup-device --version 2>&1 | head -n 1)"
  printf 'tizen  %s\n' "$(tizen version 2>&1 | tail -n 1)"
  printf 'sdb    %s\n' "$(sdb version 2>&1 | head -n 1)"
  printf '\nRun "source ~/.bashrc" or open a new box shell to use these tools.\n'
}

main() {
  # The guard runs first, so nothing happens on the host, even for --help.
  require_box
  parse_args "$@"
  install_apt_packages
  configure_shell
  install_node
  install_webos_cli
  install_tizen
  install_project_dependencies
  print_summary
}

main "$@"
