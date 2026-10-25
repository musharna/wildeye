#!/usr/bin/env bash
# pipeline/check_stars.sh — weekly: when the public repo reaches $THRESHOLD stars, leave a marker so the
# OTN data-policy notification (deferred 2026-09-12 until the project has an audience) gets sent.
# Reads GitHub's public REST API with curl (no gh login needed, so it runs on the cron host msi-4080);
# unauthenticated calls allow 60 an hour, this makes one a week.
set -euo pipefail
cd "$(dirname "$0")/.."
THRESHOLD="${THRESHOLD:-2}"
MARKER="${MARKER:-pipeline/NOTIFY_OTN_DUE}"
API="https://api.github.com/repos/musharna/wildeye"
n="$(curl -fsS --max-time 30 -H 'Accept: application/vnd.github+json' "$API" | jq -r .stargazers_count)"
if ! [[ "$n" =~ ^[0-9]+$ ]]; then
  echo "$(date -u +%Y-%m-%dT%H:%MZ) stargazers_count from $API is not a count: '$n'" >&2
  exit 1
fi
echo "$(date -u +%Y-%m-%dT%H:%MZ) stars=$n"
if [ "$n" -ge "$THRESHOLD" ] && [ ! -f "$MARKER" ]; then
  printf 'stars=%s on %s — deferred-until-audience items are due: (1) OTN notification (data@oceantrack.org), (2) browser reads of Reef Life Survey and Kelp Watch terms; see DATA_SOURCES.md\n' "$n" "$(date -u +%F)" > "$MARKER"
  echo "NOTIFY_OTN_DUE created"
fi
