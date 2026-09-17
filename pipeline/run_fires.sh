#!/usr/bin/env bash
# pipeline/run_fires.sh — every 6 h cron: refresh public/data/fires.geojson (NASA FIRMS VIIRS global 7-day CSVs, no key)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 900 "$PY" -m pipeline.fires --out public/data/fires.geojson
