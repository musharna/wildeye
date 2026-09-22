#!/usr/bin/env bash
# pipeline/run_archive.sh — cron entry: append last night's birds replay frames to public/data/birds_archive
# and prune it to the newest 30 nights. The window comes from the archive's own newest frame, so a missed
# run is caught up by the next one. Exits non-zero (and appends nothing past it) on an hour no site answers.
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks boto3/numpy (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
# ~50 s/frame at 20 sites (measured 2026-09-22), 13 frames a night; 3 h covers a two-week stall
exec timeout 10800 "$PY" -m pipeline.build_archive --catch-up --keep-nights 30 --workers 8
