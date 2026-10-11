#!/bin/sh
# Generate the full macOS icon set from build/icon.png (1024×1024):
#   build/icon.iconset/ pngs at each size + build/icon.icns (for electron-builder packaging)
# Usage: npm run gen:icon or sh scripts/gen-icon.sh

set -e
cd "$(dirname "$0")/.."

SRC=build/icon.png
ICONSET=build/icon.iconset

if [ ! -f "$SRC" ]; then
  echo "错误：找不到 $SRC" >&2
  exit 1
fi

# Corner transparency check: an icon without an alpha channel gets a black square backing in the Dock
if [ "$(sips -g hasAlpha "$SRC" | awk '/hasAlpha/{print $2}')" != "yes" ]; then
  echo "警告：$SRC 没有 alpha 通道，四角可能不透明，Dock 显示会带黑色衬底" >&2
fi

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Standard sizes required by the iconset directory (@2x = the matching scale variant)
sips -z 16   16   "$SRC" --out "$ICONSET/icon_16x16.png"      >/dev/null
sips -z 32   32   "$SRC" --out "$ICONSET/icon_16x16@2x.png"    >/dev/null
sips -z 32   32   "$SRC" --out "$ICONSET/icon_32x32.png"       >/dev/null
sips -z 64   64   "$SRC" --out "$ICONSET/icon_32x32@2x.png"    >/dev/null
sips -z 128  128  "$SRC" --out "$ICONSET/icon_128x128.png"     >/dev/null
sips -z 256  256  "$SRC" --out "$ICONSET/icon_128x128@2x.png"  >/dev/null
sips -z 256  256  "$SRC" --out "$ICONSET/icon_256x256.png"     >/dev/null
sips -z 512  512  "$SRC" --out "$ICONSET/icon_256x256@2x.png"  >/dev/null
sips -z 512  512  "$SRC" --out "$ICONSET/icon_512x512.png"     >/dev/null
sips -z 1024 1024 "$SRC" --out "$ICONSET/icon_512x512@2x.png"  >/dev/null

iconutil -c icns "$ICONSET" -o build/icon.icns
echo "已生成 build/icon.icns 和 $ICONSET/"
