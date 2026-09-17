#!/usr/bin/env bash
# pipeline/run_wastewater.sh — weekly cron (CDC updates Fridays): refresh public/data/wastewater.geojson
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks pyshp (2026-09-11 outage pattern)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 900 "$PY" -m pipeline.wastewater --out public/data/wastewater.geojson
