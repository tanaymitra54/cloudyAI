#!/usr/bin/env bash
# Sign a packaged CloudyAI.app as ONE code identity.
#
# Why this exists: CloudyAI hands screen capture to the bundled Swift helpers
# (Contents/Resources/cloudy-audio, cloudy-ear). macOS only attributes a
# helper's TCC request to the app when the helper is signed with the app's
# identity. Left unsigned, macOS records the grant against the raw executable
# path, which shows up in System Settings as a second "CloudyAI" row with a
# generic exec icon — and a new row every rebuild.
#
# Signing order matters: nested code first, the bundle seal last.
#
# Identity: $SIGN_IDENTITY, else the first Developer ID Application in the
# keychain, else ad-hoc ("-"). Ad-hoc keeps the bundle self-consistent but the
# identity still changes per build; a Developer ID is the durable fix.
set -euo pipefail

APP="${1:?usage: sign-app.sh /path/to/CloudyAI.app}"
[ -d "$APP" ] || { echo "sign-app: not an app bundle: $APP" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$ROOT/build/entitlements.mac.plist"

if [ -n "${SIGN_IDENTITY:-}" ]; then
  ID="$SIGN_IDENTITY"
elif security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  ID="$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ {print $2; exit}')"
elif security find-identity -v -p codesigning 2>/dev/null | grep -q "CloudyAI Local Signing"; then
  # Local self-signed certificate: its designated requirement is the
  # certificate hash, not the per-build cdhash, so TCC keeps one row across
  # rebuilds instead of treating each build as a new app.
  ID="CloudyAI Local Signing"
else
  ID="-"
fi

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
FRAMEWORKS="$APP/Contents/Frameworks"
RESOURCES="$APP/Contents/Resources"

# Hardened runtime only makes sense with a real developer certificate; with a
# local or ad-hoc signature it adds launch risk with no Gatekeeper benefit.
SIGN_ARGS=(--force --sign "$ID")
if [ "$ID" = "-" ] || [ "$ID" = "CloudyAI Local Signing" ]; then
  echo "sign-app: local identity '$ID' (no hardened runtime)"
else
  echo "sign-app: identity '$ID'"
  SIGN_ARGS+=(--timestamp --options runtime)
fi

sign() {
  local target="$1"; shift
  codesign "${SIGN_ARGS[@]}" "$@" "$target"
}

# 1. Nested frameworks and helper apps inside Contents/Frameworks.
if [ -d "$FRAMEWORKS" ]; then
  while IFS= read -r -d '' fw; do sign "$fw" --deep; done \
    < <(find "$FRAMEWORKS" -maxdepth 1 -name "*.framework" -print0)
  while IFS= read -r -d '' helper; do sign "$helper" --deep; done \
    < <(find "$FRAMEWORKS" -maxdepth 1 -name "*.app" -print0)
fi

# 2. The loose Swift helpers. These are the processes that ask for screen and
#    audio capture, so they must carry the app's identity.
for bin in "$RESOURCES/cloudy-audio" "$RESOURCES/cloudy-ear"; do
  [ -f "$bin" ] && sign "$bin"
done

# 3. The outer bundle, last, with the app's real identifier and entitlements.
sign "$APP" --identifier "$BUNDLE_ID" --entitlements "$ENTITLEMENTS"

# 4. Gate: never ship a bundle macOS would treat as unsigned.
codesign --verify --deep --strict --verbose=2 "$APP"

echo
echo "sign-app: $APP"
codesign -dv "$APP" 2>&1 | sed -n '1,5p'
