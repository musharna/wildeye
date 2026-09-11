#!/usr/bin/env bash
# pipeline/run_occurrences.sh — daily cron: refresh public/data/occurrences.geojson from GBIF + OBIS
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks boto3/numpy (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
exec timeout 1500 "$PY" -m pipeline.occurrences --out public/data/occurrences.geojson --days 120 --workers 4
