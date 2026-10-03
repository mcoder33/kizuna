#!/bin/bash
set -euo pipefail
MAC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_TMP="$(mktemp -d /tmp/kizuna-capture-tests.XXXXXX)"
trap 'rm -rf "$TEST_TMP"' EXIT
swiftc -parse-as-library -framework AppKit "$MAC_DIR/Sources/CaptureAppearance.swift" \
  "$MAC_DIR/Tests/capture-appearance.test.swift" -o "$TEST_TMP/appearance"
"$TEST_TMP/appearance"
swiftc -parse-as-library -framework AppKit -framework WebKit \
  "$MAC_DIR/Sources/CaptureAppearance.swift" "$MAC_DIR/Sources/QuickCapture.swift" \
  "$MAC_DIR/Sources/Navigation.swift" "$MAC_DIR/Sources/Localization.swift" \
  "$MAC_DIR/Tests/capture-panel.test.swift" -o "$TEST_TMP/panel"
"$TEST_TMP/panel"
swiftc -parse-as-library -framework AppKit -framework WebKit \
  "$MAC_DIR/Sources/CaptureAppearance.swift" "$MAC_DIR/Tests/theme-window.test.swift" -o "$TEST_TMP/theme"
"$TEST_TMP/theme" "$MAC_DIR/Resources/CaptureAppearance.js" "$MAC_DIR/../../public/theme.js"
node --test "$MAC_DIR/Tests/capture-bridge.test.cjs"
