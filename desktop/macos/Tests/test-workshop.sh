#!/bin/bash
set -euo pipefail

MAC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$MAC_DIR/../.." && pwd)"
PREVIEW_URL="${1:-http://127.0.0.1:8901/__preview?appearance=workshop&theme=light&light=day}"
BRIDGE="${2:-$MAC_DIR/Resources/CaptureAppearance.js}"
OUTPUT_DIR="${3:-}"
TEST_TMP="$(mktemp -d /tmp/kizuna-workshop-native.XXXXXX)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$TEST_TMP"
}
trap cleanup EXIT

read -r PREVIEW_PORT PREVIEW_ORIGIN < <(node -e '
const url = new URL(process.argv[1]);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/__preview") process.exit(2);
for (const [key, expected] of [["appearance","workshop"],["theme","light"],["light","day"]]) {
  if (url.searchParams.get(key) !== expected) process.exit(2);
}
process.stdout.write(`${url.port} ${url.origin}\n`);
' "$PREVIEW_URL")

if ! curl --silent --show-error --fail --max-time 2 "$PREVIEW_ORIGIN/__fixture" >/dev/null 2>&1; then
  WORKSHOP_PREVIEW_PORT="$PREVIEW_PORT" node "$ROOT/tests/fixtures/workshop-preview.mjs" >"$TEST_TMP/preview.log" 2>&1 &
  SERVER_PID=$!
  READY=0
  for _ in $(seq 1 120); do
    if curl --silent --show-error --fail --max-time 2 "$PREVIEW_ORIGIN/__fixture" >/dev/null 2>&1; then READY=1; break; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then cat "$TEST_TMP/preview.log"; exit 1; fi
    sleep 0.25
  done
  if [[ "$READY" -ne 1 ]]; then cat "$TEST_TMP/preview.log"; echo "Local workshop preview did not start" >&2; exit 1; fi
fi

swiftc -parse-as-library -framework AppKit -framework WebKit \
  "$MAC_DIR/Sources/CaptureAppearance.swift" "$MAC_DIR/Tests/workshop-appearance.test.swift" \
  -o "$TEST_TMP/workshop-appearance"
"$TEST_TMP/workshop-appearance" "$PREVIEW_URL" "$BRIDGE" "$OUTPUT_DIR"
