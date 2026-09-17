#!/usr/bin/env bash
# pipeline/run_rivers.sh — daily cron: refresh public/data/rivers.geojson (USGS Water Data OGC API daily values, public domain)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
# No key needed (~17 requests/run vs the keyless api.data.gov hourly limit); an optional
# USGS_WATER_API_KEY in the env file raises that limit.
if [ -f "$HOME/.config/wildeye/env" ]; then
	set -a
	. "$HOME/.config/wildeye/env"
	set +a
fi
exec timeout 900 "$PY" -B -m pipeline.rivers --out public/data/rivers.geojson
