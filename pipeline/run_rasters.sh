#!/usr/bin/env bash
# pipeline/run_rasters.sh — daily cron: refresh public/data/rasters/*.png + rasters.json (ERDDAP ~3.5 min/product)
set -euo pipefail
cd "$(dirname "$0")/.."
exec timeout 1800 python3 -m pipeline.raster --out public/data
