#!/bin/bash
set -euo pipefail
MAC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_TMP="$(mktemp -d /tmp/kizuna-reminder-tests.XXXXXX)"
trap 'rm -rf "$TEST_TMP"' EXIT
swiftc -parse-as-library "$MAC_DIR/Sources/UpdateReminder.swift" "$MAC_DIR/Tests/update-reminder.test.swift" -o "$TEST_TMP/reminders"
"$TEST_TMP/reminders"
