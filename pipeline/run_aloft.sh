#!/usr/bin/env bash
# pipeline/run_aloft.sh — daily cron: refresh public/data/aloft.geojson from Aloft/BALTRAD daily CSVs
set -euo pipefail
cd "$(dirname "$0")/.."
exec timeout 1200 python3 -m pipeline.aloft --out public/data/aloft.geojson --workers 12
