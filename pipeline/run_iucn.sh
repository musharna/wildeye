#!/usr/bin/env bash
# pipeline/run_iucn.sh — monthly cron: refresh public/data/seed/iucn.json (IUCN Red List category per taxon; assessments change rarely)
set -euo pipefail
cd "$(dirname "$0")/.."
# cron PATH has no miniconda; bare python3 there lacks the deps (2026-09-11 outage)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
# IUCN_TOKEN lives outside the repo
if [ -f "$HOME/.config/wildeye/env" ]; then
	set -a
	. "$HOME/.config/wildeye/env"
	set +a
fi
exec timeout 600 "$PY" -m pipeline.iucn --out public/data/seed/iucn.json
