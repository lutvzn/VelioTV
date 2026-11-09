#!/bin/sh
# Turns the app's icons into 96px PNGs in public/assets/icons. They're
# white, and the app tints them (a node's colour multiplies its image). PNGs
# rather than SVGs, which the oldest TVs may not decode as textures.
# Needs ImageMagick with an SVG reader (librsvg).
set -e
here=$(dirname "$0")
out="$here/../../public/assets/icons"
mkdir -p "$out"
for svg in "$here"/*.svg; do
  name=$(basename "$svg" .svg)
  magick -background none -density 384 "$svg" -resize 96x96 "PNG32:$out/$name.png"
done
