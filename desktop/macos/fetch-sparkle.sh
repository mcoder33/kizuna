#!/bin/bash
set -euo pipefail
MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION=2.10.0
SHA256=c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
DEST="$MAC_DIR/vendor/Sparkle-$VERSION"
if [[ -f "$DEST/.verified-$SHA256" && -d "$DEST/Sparkle.framework" ]]; then
  echo "$DEST"
  exit 0
fi
mkdir -p "$MAC_DIR/vendor"
STAGING="$(mktemp -d "$MAC_DIR/vendor/.sparkle.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
curl --fail --silent --show-error --location --retry 2 --max-time 120 \
  "https://github.com/sparkle-project/Sparkle/releases/download/$VERSION/Sparkle-$VERSION.tar.xz" -o "$STAGING/archive.tar.xz"
ACTUAL="$(shasum -a 256 "$STAGING/archive.tar.xz" | awk '{print $1}')"
[[ "$ACTUAL" == "$SHA256" ]] || { echo 'Sparkle checksum mismatch' >&2; exit 1; }
mkdir "$STAGING/unpacked"
tar -xf "$STAGING/archive.tar.xz" -C "$STAGING/unpacked"
touch "$STAGING/unpacked/.verified-$SHA256"
[[ ! -e "$DEST" ]] || { echo "Remove incomplete Sparkle cache: $DEST" >&2; exit 1; }
mv "$STAGING/unpacked" "$DEST"
echo "$DEST"
