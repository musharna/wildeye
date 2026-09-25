#!/usr/bin/env bash
# pipeline/seed.sh — copy committed seed snapshots into public/data for any live file that is missing.
# Live files are rewritten by cron and gitignored; seeds keep a fresh clone from showing empty layers.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in birds aloft occurrences tracks wastewater otn hpai neon gfw whispers arbonet phenology neon-vectors cetaceans drought h5n1 fires ecoregions rivers gmw griis; do
  if [ ! -s "public/data/$f.geojson" ]; then cp "public/data/seed/$f.geojson" "public/data/$f.geojson"; echo "seeded $f.geojson"; fi
done
if [ ! -s public/data/gibs.json ]; then cp public/data/seed/gibs.json public/data/gibs.json; echo "seeded gibs.json"; fi
