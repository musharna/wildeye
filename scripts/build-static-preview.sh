#!/usr/bin/env bash
# Build the GitHub Pages flavour into .qa-static/ (same flags and Cesium relocation as
# pipeline/deploy_pages.sh) for local browser checks.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node24/bin:$PATH"
OUT=.qa-static
VITE_STATIC_HOST=1 npx vite build --base=/wildeye/ --outDir "$OUT" --emptyOutDir >/dev/null
if [ -d "$OUT/wildeye/cesium" ]; then
  rm -rf "$OUT/cesium" && mv "$OUT/wildeye/cesium" "$OUT/cesium" && rmdir "$OUT/wildeye" 2>/dev/null || true
fi
[ -f "$OUT/index.html" ] || { echo "build produced no $OUT/index.html" >&2; exit 1; }
echo "built $OUT; serve with: npx vite preview --base /wildeye/ --outDir $OUT --port 4488 --strictPort"
