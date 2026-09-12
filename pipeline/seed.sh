#!/usr/bin/env bash
# pipeline/seed.sh — copy committed seed snapshots into public/data for any live file that is missing.
# Live files are rewritten by cron and gitignored; seeds keep a fresh clone from showing empty layers.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in birds aloft occurrences tracks wastewater otn; do
  if [ ! -s "public/data/$f.geojson" ]; then cp "public/data/seed/$f.geojson" "public/data/$f.geojson"; echo "seeded $f.geojson"; fi
done
