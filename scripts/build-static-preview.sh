#!/usr/bin/env bash
# Build the GitHub Pages flavour into .qa-static/ (same flags as pipeline/deploy_pages.sh)
# for local browser checks.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node24/bin:$PATH"
OUT=.qa-static
npx vite build --base=/wildeye/ --outDir "$OUT" --emptyOutDir >/dev/null
[ -f "$OUT/index.html" ] || { echo "build produced no $OUT/index.html" >&2; exit 1; }
echo "built $OUT; serve with: npx vite preview --base /wildeye/ --outDir $OUT --port 4488 --strictPort"
