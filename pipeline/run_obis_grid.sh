#!/usr/bin/env bash
# pipeline/run_obis_grid.sh — monthly cron: refresh public/data/obis_grid.json (OBIS records per 1° cell, CC0 and CC BY
# datasets only). Built once on 2026-10-03 and never again, the grid kept records OBIS later re-flagged as absences
# (472,199 in one Monterey cell by 2026-11-01): OBIS reprocesses datasets, so the grid is rebuilt every month.
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
# staging is keyed by each export file's ETag, so a month reads only the datasets OBIS changed (185 of 4,125 in October)
exec timeout 14400 "$PY" -m pipeline.obis_grid --out-dir public/data
