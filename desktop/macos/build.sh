#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MAC_DIR="$ROOT/desktop/macos"
SOURCE_DIR="$MAC_DIR/Sources"
DIST_DIR="$MAC_DIR/dist"
APP_NAME="Kizuna"
APP_ID="space.agenthub.kizuna"
BUILD_ARCH="$(uname -m)"
UNIVERSAL=0

usage() {
  cat <<'EOF'
Usage: ./desktop/macos/build.sh [--universal]

Build the macOS app, ZIP archive, and DMG using the active Apple Swift toolchain.
By default, build for the host architecture. --universal builds arm64 and x86_64.
EOF
}

while (($#)); do
  case "$1" in
    --universal) UNIVERSAL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ ! -d "$SOURCE_DIR" ]] || ! compgen -G "$SOURCE_DIR/*.swift" >/dev/null; then
  echo "No Swift sources found in $SOURCE_DIR" >&2
  exit 1
fi
if ! command -v swiftc >/dev/null || ! command -v hdiutil >/dev/null; then
  echo "Install Xcode Command Line Tools (swiftc and hdiutil are required)." >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
SPARKLE_DIR="$(bash "$MAC_DIR/fetch-sparkle.sh")"
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kizuna-macos.XXXXXX")"
trap 'rm -rf "$BUILD_ROOT"' EXIT
APP="$BUILD_ROOT/$APP_NAME.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
MACOS="$CONTENTS/MacOS"
mkdir -p "$RESOURCES" "$MACOS"

cp "$MAC_DIR/Info.plist" "$CONTENTS/Info.plist"
cp "$ROOT/public/icon.svg" "$RESOURCES/AppIcon.svg"
cp "$MAC_DIR/Resources/RestartGuard.js" "$RESOURCES/RestartGuard.js"
cp "$MAC_DIR/Resources/CaptureAppearance.js" "$RESOURCES/CaptureAppearance.js"
(cd "$ROOT" && node --input-type=module -e 'import { catalogs } from "./public/i18n-catalog.js"; process.stdout.write(JSON.stringify(catalogs));') > "$RESOURCES/i18n-catalog.json"
mkdir -p "$CONTENTS/Frameworks"
ditto "$SPARKLE_DIR/Sparkle.framework" "$CONTENTS/Frameworks/Sparkle.framework"

ICON_WORK="$BUILD_ROOT/icon"
mkdir -p "$ICON_WORK/Rendered" "$ICON_WORK/AppIcon.iconset"
qlmanage -t -s 1024 -o "$ICON_WORK/Rendered" "$ROOT/public/icon.svg" >/dev/null
ICON_PNG="$ICON_WORK/Rendered/icon.svg.png"
if [[ ! -f "$ICON_PNG" ]]; then
  echo "Quick Look did not render public/icon.svg to PNG." >&2
  exit 1
fi
for spec in 16x16:16 16x16@2x:32 32x32:32 32x32@2x:64 128x128:128 128x128@2x:256 256x256:256 256x256@2x:512 512x512:512 512x512@2x:1024; do
  name="${spec%%:*}"
  pixels="${spec#*:}"
  sips -z "$pixels" "$pixels" "$ICON_PNG" --out "$ICON_WORK/AppIcon.iconset/icon_${name}.png" >/dev/null
done
iconutil -c icns "$ICON_WORK/AppIcon.iconset" -o "$RESOURCES/AppIcon.icns"

SOURCES=("$SOURCE_DIR"/*.swift)
FRAMEWORKS=(-framework AppKit -framework WebKit -framework UserNotifications -framework Carbon
  -F "$SPARKLE_DIR" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks)
if ((UNIVERSAL)); then
  for arch in arm64 x86_64; do
    swiftc -O -target "$arch-apple-macosx13.0" -module-name "$APP_NAME" \
      "${FRAMEWORKS[@]}" "${SOURCES[@]}" -o "$BUILD_ROOT/$APP_NAME-$arch"
  done
  lipo -create "$BUILD_ROOT/$APP_NAME-arm64" "$BUILD_ROOT/$APP_NAME-x86_64" -output "$MACOS/$APP_NAME"
else
  case "$BUILD_ARCH" in
    arm64|x86_64) ;;
    *) echo "Unsupported host architecture: $BUILD_ARCH" >&2; exit 1 ;;
  esac
  swiftc -O -target "$BUILD_ARCH-apple-macosx13.0" -module-name "$APP_NAME" \
    "${FRAMEWORKS[@]}" "${SOURCES[@]}" -o "$MACOS/$APP_NAME"
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $APP_ID" "$CONTENTS/Info.plist"
codesign --force --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# Remove the previous bundle first so obsolete files cannot remain in the output.
if [[ -e "$DIST_DIR/$APP_NAME.app" ]]; then
  python3 - "$DIST_DIR/$APP_NAME.app" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1])
PY
fi
ditto "$APP" "$DIST_DIR/$APP_NAME.app"

ditto -c -k --sequesterRsrc --keepParent "$DIST_DIR/$APP_NAME.app" "$DIST_DIR/$APP_NAME.zip"
DMG_STAGE="$BUILD_ROOT/dmg"
mkdir -p "$DMG_STAGE"
ditto "$DIST_DIR/$APP_NAME.app" "$DMG_STAGE/$APP_NAME.app"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DIST_DIR/$APP_NAME.dmg" >/dev/null
hdiutil verify "$DIST_DIR/$APP_NAME.dmg" >/dev/null

echo "Built $DIST_DIR/$APP_NAME.app"
echo "Built $DIST_DIR/$APP_NAME.zip"
echo "Built $DIST_DIR/$APP_NAME.dmg"
echo "Architectures: $(lipo -archs "$DIST_DIR/$APP_NAME.app/Contents/MacOS/$APP_NAME")"
