#!/usr/bin/env bash
# Build the Parakeet ASR helper (native/CloudyEar) in release mode.
# Output: native/CloudyEar/.build/release/CloudyEar — bundled into the app by
# electron-builder as Contents/Resources/cloudy-ear.
set -euo pipefail

cd "$(dirname "$0")/../native/CloudyEar"
swift build -c release

BIN="$PWD/.build/release/CloudyEar"
[ -x "$BIN" ] || { echo "build finished but $BIN is missing" >&2; exit 1; }
printf 'built %s (%s)\n' "$BIN" "$(du -h "$BIN" | cut -f1)"
