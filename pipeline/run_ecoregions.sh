#!/usr/bin/env bash
# pipeline/run_ecoregions.sh — monthly cron: refresh public/data/ecoregions.geojson (RESOLVE Ecoregions 2017, static; CC BY 4.0)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 900 "$PY" -m pipeline.ecoregions --out public/data/ecoregions.geojson
