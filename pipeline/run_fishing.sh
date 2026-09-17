#!/usr/bin/env bash
# pipeline/run_fishing.sh — daily cron: refresh public/data/fishing.geojson (Global Fishing Watch 4Wings apparent fishing effort, 1° weekly grid)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
# GFW_FISHING_TOKEN (Global Fishing Watch API token — not the forest-watch GFW_API_KEY) lives outside the repo
if [ -f "$HOME/.config/wildeye/env" ]; then
	set -a
	. "$HOME/.config/wildeye/env"
	set +a
fi
exec timeout 900 "$PY" -B -m pipeline.fishing --out public/data/fishing.geojson
