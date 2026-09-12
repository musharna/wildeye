#!/usr/bin/env bash
# pipeline/run_neon.sh — weekly cron: refresh public/data/neon.geojson (NEON small mammal trapping; provisional data monthly)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
# NEON_TOKEN lives outside the repo
if [ -f "$HOME/.config/wildeye/env" ]; then set -a; . "$HOME/.config/wildeye/env"; set +a; fi
exec timeout 1800 "$PY" -m pipeline.neon --out public/data/neon.geojson
