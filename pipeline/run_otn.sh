#!/usr/bin/env bash
# pipeline/run_otn.sh — weekly cron: refresh public/data/otn.geojson (OTN public detections lag ~1 y; gateway 503s intermittently, fetcher retries)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
exec timeout 3000 "$PY" -m pipeline.otn --out public/data/otn.geojson
