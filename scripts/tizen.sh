#!/usr/bin/env bash
# Use the selected SDK and this checkout's private signing profiles.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tizen-env.sh"
tizen_require_cli
tizen_cli "$@"
