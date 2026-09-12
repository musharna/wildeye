#!/usr/bin/env bash
# pipeline/run_gfw.sh — daily cron: refresh public/data/gfw.geojson (GFW integrated alerts by country; versions daily)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
# GFW_API_KEY lives outside the repo
if [ -f "$HOME/.config/wildeye/env" ]; then set -a; . "$HOME/.config/wildeye/env"; set +a; fi
exec timeout 900 "$PY" -m pipeline.gfw --out public/data/gfw.geojson
