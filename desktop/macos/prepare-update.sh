#!/bin/bash
# Prepares signed release files locally. Does not publish or deploy anything.
set -euo pipefail
MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
SPARKLE_DIR="$(bash "$MAC_DIR/fetch-sparkle.sh")"
APP="$MAC_DIR/dist/Kizuna.app"
OUTPUT="$MAC_DIR/dist/updates"
ACCOUNT=space.agenthub.kizuna.updates
[[ -d "$APP" ]] || { echo 'Build the app first: bash desktop/macos/build.sh --universal' >&2; exit 1; }
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
PUBLIC_KEY="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$APP/Contents/Info.plist")"
SIGNING_KEY="$("$SPARKLE_DIR/bin/generate_keys" --account "$ACCOUNT" -p)"
[[ "$PUBLIC_KEY" == "$SIGNING_KEY" ]] || { echo 'The signing key does not match the key embedded in this app.' >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]] || { echo 'Invalid build version' >&2; exit 1; }
codesign --verify --deep --strict "$APP"
mkdir -p "$OUTPUT"
ARCHIVE="$OUTPUT/Kizuna-$VERSION.zip"
[[ ! -e "$ARCHIVE" ]] || { echo "Build $VERSION is already prepared. Increment CFBundleVersion for a new release." >&2; exit 1; }
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
"$SPARKLE_DIR/bin/generate_appcast" --account "$ACCOUNT" --maximum-deltas 0 \
  --download-url-prefix https://yourkizuna.com/public/downloads/mac/ "$OUTPUT"
"$SPARKLE_DIR/bin/sign_update" --account "$ACCOUNT" --verify "$OUTPUT/appcast.xml"
echo "Prepared signed update in $OUTPUT. Nothing has been published."
