#!/usr/bin/env bash
# pipeline/run_birds_remote.sh — cron entry: run run_birds.sh on another host, pull its outputs back here.
# Moved off the laptop 2026-10-20: build_birds (8 workers, ~7 of every 10 min) was the laptop's standing load.
# The remote copy keeps the state build_birds merges with (last-good outputs, ~/.cache/wildeye/vp); this side
# pushes the current pipeline/ code each run and pulls outputs + profiles back, so deploy_pages, run_archive
# and pair_check/rain_check keep reading local files. Remote setup: ~/wildeye-birds-venv (uv, py3.12,
# arm_pyart 2.2.5, boto3, numpy 2.3.5, pillow 12.3.0) + the digest-pinned vol2bird image from vol2bird.py.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${WILDEYE_BIRDS_HOST:-msi-4080}"
RDIR=wildeye-birds
SSH="ssh -o BatchMode=yes -o ConnectTimeout=15"
exec 9>"${TMPDIR:-/tmp}/wildeye-run-birds-remote.lock"
flock -n 9 || { echo "$(date -Is) run_birds_remote: previous run still going, skipping"; exit 0; }

rsync -a --delete --exclude __pycache__ -e "$SSH" pipeline/ "$HOST:$RDIR/pipeline/"
$SSH "$HOST" "mkdir -p $RDIR/public/data && WILDEYE_PYTHON=\$HOME/wildeye-birds-venv/bin/python $RDIR/pipeline/run_birds.sh"
# images before the json that points at them; each file lands atomically (rsync temp + rename)
rsync -a --exclude '*.tmp.png' -e "$SSH" "$HOST:$RDIR/public/data/birds_ppi/" public/data/birds_ppi/
for f in birds_field.png birds_field.json birds.geojson birds_nights.json birds_seasons.json; do
  rsync -a -e "$SSH" "$HOST:$RDIR/public/data/$f" public/data/
done
# mirror: the remote run prunes profiles past --vp-keep-days
rsync -a --delete -e "$SSH" "$HOST:.cache/wildeye/vp/" "$HOME/.cache/wildeye/vp/"
