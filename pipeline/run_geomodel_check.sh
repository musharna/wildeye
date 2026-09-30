#!/usr/bin/env bash
# pipeline/run_geomodel_check.sh — monthly cron: test iNaturalist's geomodel per collection against non-iNaturalist GBIF
# records and write public/data/geomodel_verdicts.json (spec: docs/superpowers/specs/2026-09-29-geomodel-harness-design.md).
# Exit 2 = a control failed and nothing was written.
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
exec timeout 14400 "$PY" -m pipeline.geomodel_check --out public/data/geomodel_verdicts.json "$@"
