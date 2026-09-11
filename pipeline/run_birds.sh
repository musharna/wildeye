#!/usr/bin/env bash
# pipeline/run_birds.sh — cron entry: refresh public/data/birds.geojson
set -euo pipefail
cd "$(dirname "$0")/.."
exec timeout 540 python3 -m pipeline.build_birds --out public/data/birds.geojson --workers 8
