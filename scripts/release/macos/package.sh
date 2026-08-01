#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: scripts/release/macos/package.sh <payload-root> <app-path> <dmg-path> <bundle-version>" >&2
  exit 2
fi

PAYLOAD_ROOT="$1"
APP_PATH="$2"
DMG_PATH="$3"
BUNDLE_VERSION="$4"

case "$APP_PATH" in
  */codexhost.app) ;;
  *) echo "error: app output must end with /codexhost.app" >&2; exit 2 ;;
esac
case "$DMG_PATH" in
  *.dmg) ;;
  *) echo "error: DMG output must end with .dmg" >&2; exit 2 ;;
esac

for relative in \
  bin/codexhost \
  libexec/codexhost-shim \
  runtime/node \
  app/desktop-controller.mjs \
  app/host-runtime.mjs \
  app/renderer-extension.js \
  licenses/Node.js-LICENSE.txt \
  licenses/Anthropic-SDK-LICENSE.txt \
  licenses/Claude-Agent-SDK-LICENSE.md \
  licenses/MCP-SDK-LICENSE.txt \
  licenses/diff-LICENSE.txt \
  licenses/zod-LICENSE.txt \
  THIRD_PARTY_NOTICES.txt; do
  test -f "$PAYLOAD_ROOT/$relative" || {
    echo "error: missing Payload file: $relative" >&2
    exit 1
  }
done

OUTPUT_DIRECTORY="$(dirname "$DMG_PATH")"
DMG_STAGE="$OUTPUT_DIRECTORY/.codexhost-dmg-stage-$$"
cleanup() {
  rm -rf "$DMG_STAGE"
}
trap cleanup EXIT

CONTENTS="$APP_PATH/Contents"
RESOURCES="$CONTENTS/Resources"
rm -rf "$APP_PATH" "$DMG_STAGE"
rm -f "$DMG_PATH"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES" "$OUTPUT_DIRECTORY"

cp "$PAYLOAD_ROOT/bin/codexhost" "$CONTENTS/MacOS/codexhost"
cp -R "$PAYLOAD_ROOT/libexec" "$RESOURCES/libexec"
cp -R "$PAYLOAD_ROOT/runtime" "$RESOURCES/runtime"
cp -R "$PAYLOAD_ROOT/app" "$RESOURCES/app"
cp -R "$PAYLOAD_ROOT/licenses" "$RESOURCES/licenses"
cp "$PAYLOAD_ROOT/THIRD_PARTY_NOTICES.txt" "$RESOURCES/THIRD_PARTY_NOTICES.txt"
chmod 755 \
  "$CONTENTS/MacOS/codexhost" \
  "$RESOURCES/libexec/codexhost-shim" \
  "$RESOURCES/runtime/node"
printf 'APPL????' > "$CONTENTS/PkgInfo"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>codexhost</string>
  <key>CFBundleExecutable</key>
  <string>codexhost</string>
  <key>CFBundleIdentifier</key>
  <string>com.codexhost.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>codexhost</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$BUNDLE_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUNDLE_VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$CONTENTS/Info.plist" >/dev/null
/usr/bin/codesign --force --sign - "$RESOURCES/runtime/node"
/usr/bin/codesign --force --sign - "$RESOURCES/libexec/codexhost-shim"
/usr/bin/codesign --force --sign - "$CONTENTS/MacOS/codexhost"
/usr/bin/codesign --force --sign - "$APP_PATH"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
"$RESOURCES/runtime/node" -e 'if (process.version !== "v24.13.1") process.exit(1)'

mkdir -p "$DMG_STAGE"
/usr/bin/ditto "$APP_PATH" "$DMG_STAGE/codexhost.app"
ln -s /Applications "$DMG_STAGE/Applications"
/usr/bin/codesign --verify --deep --strict "$DMG_STAGE/codexhost.app"
/usr/bin/hdiutil create \
  -volname "codexhost" \
  -srcfolder "$DMG_STAGE" \
  -format UDZO \
  -ov \
  "$DMG_PATH" >/dev/null
/usr/bin/hdiutil verify "$DMG_PATH" >/dev/null

test -s "$DMG_PATH" || {
  echo "error: macOS DMG is missing or empty: $DMG_PATH" >&2
  exit 1
}
