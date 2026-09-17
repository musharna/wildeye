#!/usr/bin/env bash
# pipeline/run_h5n1.sh — daily cron: refresh public/data/h5n1.geojson
# (Nextstrain avian-flu H5N1 genome-focused builds, open NCBI/USDA data; no key needed)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 900 "$PY" -m pipeline.h5n1 --out public/data/h5n1.geojson
