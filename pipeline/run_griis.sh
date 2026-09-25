#!/usr/bin/env bash
# pipeline/run_griis.sh — monthly cron: refresh public/data/griis.geojson (GRIIS introduced species per checklist, ISSG via GBIF; CC BY 4.0 / CC0)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
# a cold cache fetches ~307 archives at 5-10 s each; a warm month refetches only new versions
exec timeout 3600 "$PY" -m pipeline.griis --out public/data/griis.geojson
