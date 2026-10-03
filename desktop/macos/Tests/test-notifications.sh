#!/bin/bash
set -euo pipefail
MAC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/kizuna-notifications.XXXXXX")"
trap 'rm -rf "$TEST_TMP"' EXIT
swiftc -parse-as-library "$MAC_DIR/Sources/NotificationDelivery.swift" "$MAC_DIR/Tests/notification-delivery.swift" -o "$TEST_TMP/delivery"
"$TEST_TMP/delivery"
swiftc -parse-as-library -framework AppKit -framework WebKit -framework UserNotifications \
  "$MAC_DIR/Sources/Localization.swift" "$MAC_DIR/Sources/NotificationDelivery.swift" \
  "$MAC_DIR/Sources/Notifications.swift" "$MAC_DIR/Tests/notification-policy.swift" -o "$TEST_TMP/policy"
"$TEST_TMP/policy"
