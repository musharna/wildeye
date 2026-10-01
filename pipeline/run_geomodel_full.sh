#!/usr/bin/env bash
# pipeline/run_geomodel_full.sh — daily cron: the full every-tile check of public/data/geomodel_species.json, at most
# 8,000 tile requests a run (iNaturalist asks for under 10,000 a day; spec 2026-09-30-modeled-range, "Skim first").
# Picks up where the last run stopped; once every species is fully checked it asks nothing and exits 0.
# Exit 3 = species still unchecked (budget reached or tiles failed): the next day's run goes on.
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 43200 "$PY" -m pipeline.geomodel_species --mode full --max-tiles "${GEOMODEL_MAX_TILES:-8000}" \
  --verdicts public/data/geomodel_verdicts.json --out public/data/geomodel_species.json "$@"
