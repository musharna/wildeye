#!/usr/bin/env bash
# pipeline/run_cetaceans.sh — weekly cron: refresh public/data/cetaceans.geojson (NOAA PACM static files; public record lags months)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
exec timeout 900 "$PY" -m pipeline.cetaceans --out public/data/cetaceans.geojson
