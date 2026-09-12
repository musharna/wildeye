#!/usr/bin/env bash
# pipeline/run_hpai.sh — daily cron: refresh public/data/hpai.geojson (APHIS CSV, ~2 MB, updated weekly)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
exec timeout 1200 "$PY" -m pipeline.hpai --out public/data/hpai.geojson
