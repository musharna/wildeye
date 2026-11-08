#!/usr/bin/env bash
# pipeline/run_archive.sh — cron entry: append last night's birds replay frames to public/data/birds_archive
# and prune it to the newest 14 nights (pipeline/build_archive.py KEEP_NIGHTS). The window starts after the archive's end (its newest
# frame or terminally missing hour, build_archive.archive_end), so a missed run is caught up by the next one. An hour no site answers stops the run (exit 1, nothing appended past it) and is
# retried by later runs; after MISSING_TRIES tries over MISSING_AGE it is recorded as terminally missing in the manifest
# and the run appends every settled hour past it, still exiting 1 once to report the hour it gave up on.
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks boto3/numpy (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
# ~50 s/frame at 20 sites (measured 2026-09-22), 13 frames a night; 3 h covers a two-week stall
exec timeout 10800 "$PY" -m pipeline.build_archive --catch-up --keep-nights 14 --workers 8
