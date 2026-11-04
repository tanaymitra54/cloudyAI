#!/usr/bin/env bash
# Build the system-audio helper (native/CloudyAudio) in release mode.
# Output: native/CloudyAudio/.build/release/CloudyAudio — bundled into the app
# by electron-builder as Contents/Resources/cloudy-audio.
set -euo pipefail

cd "$(dirname "$0")/../native/CloudyAudio"
swift build -c release

BIN="$PWD/.build/release/CloudyAudio"
[ -x "$BIN" ] || { echo "build finished but $BIN is missing" >&2; exit 1; }
printf 'built %s (%s)\n' "$BIN" "$(du -h "$BIN" | cut -f1)"
