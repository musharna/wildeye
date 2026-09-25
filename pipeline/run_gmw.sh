#!/usr/bin/env bash
# pipeline/run_gmw.sh — monthly cron: refresh public/data/gmw.geojson (Global Mangrove Watch v4.1.12 country extent, 1985–2025; CC BY 4.0)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 900 "$PY" -m pipeline.gmw --out public/data/gmw.geojson
