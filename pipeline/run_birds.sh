#!/usr/bin/env bash
# pipeline/run_birds.sh — cron entry: refresh public/data/birds.geojson
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks boto3/numpy (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 540 "$PY" -m pipeline.build_birds --out public/data/birds.geojson --workers 8
