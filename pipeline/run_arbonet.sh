#!/usr/bin/env bash
# pipeline/run_arbonet.sh — daily cron: refresh public/data/arbonet.geojson (CDC NNDSS weekly arboviral cases by state)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
exec timeout 900 "$PY" -m pipeline.arbonet --out public/data/arbonet.geojson
