#!/usr/bin/env bash
# pipeline/run_rasters.sh — daily cron: refresh public/data/rasters/*.png + rasters.json (ERDDAP ~3.5 min/product)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks boto3/numpy (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
# Copernicus Marine credentials (cmems-* products) live outside the repo
if [ -f "$HOME/.config/wildeye/env" ]; then set -a; . "$HOME/.config/wildeye/env"; set +a; fi
exec timeout 1800 "$PY" -m pipeline.raster --out public/data
