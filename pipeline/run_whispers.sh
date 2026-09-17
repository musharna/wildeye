#!/usr/bin/env bash
# pipeline/run_whispers.sh — daily cron: refresh public/data/whispers.geojson (USGS WHISPers, public API)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 900 "$PY" -m pipeline.whispers --out public/data/whispers.geojson
