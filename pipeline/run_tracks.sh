#!/usr/bin/env bash
# pipeline/run_tracks.sh — weekly cron: refresh public/data/tracks.geojson (ATN is archival; serial polite fetch)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
# Movebank credentials live outside the repo; the ATN source needs none
if [ -f "$HOME/.config/wildeye/env" ]; then set -a; . "$HOME/.config/wildeye/env"; set +a; fi
exec timeout 3000 "$PY" -m pipeline.tracks --out public/data/tracks.geojson
