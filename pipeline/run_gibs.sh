#!/usr/bin/env bash
# pipeline/run_gibs.sh — daily cron: refresh public/data/gibs.json (NASA GIBS tile sets, served dates, legends; no key)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 600 "$PY" -B -m pipeline.gibs --out public/data/gibs.json
