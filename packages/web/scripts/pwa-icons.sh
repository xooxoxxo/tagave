#!/bin/sh
# The home-screen icons in public/icons/, from public/tagave-mark.svg (light
# styling): the mark alone at 192 and 512 px ("any"), and the mark on the
# light canvas at 512 px ("maskable", the same treatment as
# apple-touch-icon.png, the mark inside the 80 % safe circle so no launcher
# mask clips it). Run by hand after the mark changes; needs rsvg-convert
# (brew install librsvg). The PNGs are committed.
set -eu
cd "$(dirname "$0")/.."
out=public/icons
mkdir -p "$out"
rsvg-convert -w 192 -h 192 public/tagave-mark.svg -o "$out/icon-192.png"
rsvg-convert -w 512 -h 512 public/tagave-mark.svg -o "$out/icon-512.png"
# maskable: canvas #f6f8fa (tokens.css --canvas, light), the mark at 76 %
tmp=$(mktemp -d)
mark="data:image/svg+xml;base64,$(base64 < public/tagave-mark.svg | tr -d '\n')"
cat > "$tmp/maskable.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#f6f8fa"/>
  <image x="61.44" y="61.44" width="389.12" height="389.12" xlink:href="$mark"/>
</svg>
SVG
rsvg-convert -w 512 -h 512 "$tmp/maskable.svg" -o "$out/maskable-512.png"
rm -rf "$tmp"
ls -l "$out"
