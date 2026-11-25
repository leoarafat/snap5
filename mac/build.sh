#!/bin/sh
# Builds Snap5.app with the Apple Command Line Tools. No downloads, no third-party code.
#   ./build.sh            build into mac/build/Snap5.app
#   ./build.sh install    build, then copy to /Applications
set -eu
cd "$(dirname "$0")"
ROOT=..
APP=build/Snap5.app
VERSION=1.0.0

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web/lib" "$APP/Contents/Resources/web/content" build/Snap5.iconset

swiftc -O -parse-as-library -target arm64-apple-macos14.0 -swift-version 5 \
  Sources/*.swift -o "$APP/Contents/MacOS/Snap5"

# The selection and markup code is shared with the Chrome extension.
cp web/capture.html web/shim.js web/app.js "$APP/Contents/Resources/web/"
for f in common export annotator toolbar; do cp "$ROOT/lib/$f.js" "$APP/Contents/Resources/web/lib/"; done
cp "$ROOT/content/ui.js" "$ROOT/content/overlay.js" "$APP/Contents/Resources/web/content/"

for size in 16 32 128 256 512; do
  sips -z $size $size icon.png --out "build/Snap5.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) icon.png --out "build/Snap5.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns build/Snap5.iconset -o "$APP/Contents/Resources/Snap5.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Snap5</string>
  <key>CFBundleDisplayName</key><string>Snap5</string>
  <key>CFBundleIdentifier</key><string>com.snap5.mac</string>
  <key>CFBundleExecutable</key><string>Snap5</string>
  <key>CFBundleIconFile</key><string>Snap5</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

# Local ("ad-hoc") signature: enough to run on this Mac.
codesign --force --sign - "$APP"
echo "Built $APP"

if [ "${1:-}" = "install" ]; then
  if pgrep -xq Snap5; then echo "Quit Snap5 first (menu bar → Quit Snap5), then run this again."; exit 1; fi
  ditto "$APP" /Applications/Snap5.app
  echo "Installed to /Applications/Snap5.app"
fi
