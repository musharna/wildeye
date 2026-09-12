#!/usr/bin/env bash
# pipeline/check_stars.sh — weekly: when the public repo reaches $THRESHOLD stars, leave a marker so the
# OTN data-policy notification (deferred 2026-09-12 until the project has an audience) gets sent.
set -euo pipefail
cd "$(dirname "$0")/.."
THRESHOLD="${THRESHOLD:-2}"
n="$(gh api repos/musharna/wildeye --jq .stargazers_count)"
echo "$(date -u +%Y-%m-%dT%H:%MZ) stars=$n"
if [ "$n" -ge "$THRESHOLD" ] && [ ! -f pipeline/NOTIFY_OTN_DUE ]; then
  printf 'stars=%s on %s — send the OTN notification (data@oceantrack.org); see DATA_SOURCES.md OTN row\n' "$n" "$(date -u +%F)" > pipeline/NOTIFY_OTN_DUE
  echo "NOTIFY_OTN_DUE created"
fi
