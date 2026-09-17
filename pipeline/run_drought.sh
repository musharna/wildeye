#!/usr/bin/env bash
# pipeline/run_drought.sh — weekly cron (Thursday, after the ~10:15 UTC release): refresh public/data/drought.geojson
# (U.S. Drought Monitor D0–D4, newest 5 weekly releases; no key needed)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 900 "$PY" -B -m pipeline.drought --out public/data/drought.geojson
