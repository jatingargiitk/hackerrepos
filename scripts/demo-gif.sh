#!/usr/bin/env bash
# Rebuild docs/screenshot.png and docs/demo.gif from the live site.
#   scripts/demo-gif.sh   (needs google-chrome or $CHROME, ffmpeg, Node 22+)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
frames=$(mktemp -d)
node "$root/scripts/capture.mjs" "$frames" 1280 800
cp "$frames/001-overview.png" "$root/docs/screenshot.png"
ffmpeg -loglevel error -y -framerate 6 -pattern_type glob -i "$frames/*.png" \
  -vf "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  "$root/docs/demo.gif"
rm -rf "$frames"
ls -la "$root/docs/screenshot.png" "$root/docs/demo.gif"
