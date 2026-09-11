#!/usr/bin/env bash
# pipeline/run_aloft.sh — daily cron: refresh public/data/aloft.geojson from Aloft/BALTRAD daily CSVs
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks boto3/numpy (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
exec timeout 1200 "$PY" -m pipeline.aloft --out public/data/aloft.geojson --workers 12
