#!/usr/bin/env bash
# pipeline/run_rasters.sh — daily cron: refresh public/data/rasters/*.png + rasters.json (ERDDAP ~3.5 min/product)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks boto3/numpy (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
exec timeout 1800 "$PY" -m pipeline.raster --out public/data
