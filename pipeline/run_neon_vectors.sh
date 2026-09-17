#!/usr/bin/env bash
# pipeline/run_neon_vectors.sh — weekly cron: refresh public/data/neon-vectors.geojson (NEON ticks + mosquitoes; provisional data monthly)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
# NEON_TOKEN lives outside the repo
if [ -f "$HOME/.config/wildeye/env" ]; then set -a; . "$HOME/.config/wildeye/env"; set +a; fi
exec timeout 900 "$PY" -B -m pipeline.neon_vectors --out public/data/neon-vectors.geojson
