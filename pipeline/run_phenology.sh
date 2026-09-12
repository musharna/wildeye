#!/usr/bin/env bash
# pipeline/run_phenology.sh — daily cron: refresh public/data/phenology.geojson (USA-NPN status reports, public API, no key)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
exec timeout 900 "$PY" -m pipeline.phenology --out public/data/phenology.geojson
