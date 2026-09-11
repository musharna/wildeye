#!/usr/bin/env bash
# pipeline/run_occurrences.sh — daily cron: refresh public/data/occurrences.geojson from GBIF + OBIS
set -euo pipefail
cd "$(dirname "$0")/.."
exec timeout 1500 python3 -m pipeline.occurrences --out public/data/occurrences.geojson --days 120 --workers 4
