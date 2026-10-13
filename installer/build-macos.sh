#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must be run on macOS." >&2
  exit 1
fi

cd "${REPO_ROOT}"

echo "Installing frontend dependencies..."
npm --prefix ui ci

echo "Building ad-hoc signed macOS .app and .dmg bundles..."
# Extra arguments are forwarded, e.g.:
#   ./installer/build-macos.sh --target aarch64-apple-darwin
#   ./installer/build-macos.sh --target x86_64-apple-darwin
# No --no-sign: tauri.macos.conf.json sets signingIdentity "-" (ad-hoc), matching the release workflow.
# Updater artifacts are disabled for local builds: they need the updater private key, which only CI has.
cargo tauri build --ci --bundles app,dmg --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@"

echo
echo "macOS bundles are available under:"
find "${REPO_ROOT}/target" -type d -path '*/release/bundle' -print
