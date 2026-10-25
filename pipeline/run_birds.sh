#!/usr/bin/env bash
# pipeline/run_birds.sh — cron entry: refresh public/data/birds.geojson
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks boto3/numpy (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
# deploy_pages.sh holds this lock while it copies the outputs, so it never ships a half-rewritten set; the build keeps
# it (fd 9 survives exec) until it exits
exec 9>"${WILDEYE_LOCK_DIR:-/tmp}/wildeye-birds.lock"
flock -w "${BIRDS_LOCK_WAIT:-120}" 9 || {
  echo "$(date -Is) run_birds: a deploy still holds the birds lock after ${BIRDS_LOCK_WAIT:-120} s; skipping this run" >&2
  exit 75
}
exec timeout 540 "$PY" -m pipeline.build_birds --out public/data/birds.geojson --workers 8
