# wildeye M1 — Birds-on-radar layer

Date: 2026-09-10. Status: approved in chat.

## Goal
A biology spin-off of gods-eye-view. M1 adds one live layer: nocturnal bird
migration density derived from NEXRAD weather radar, rendered on the globe.

## Repo
`~/wildeye`, cloned from `bilawalsidhu/gods-eye-view` @7596522 with full history.
Remote `upstream` retained for merging fixes. Upstream layers untouched in M1.
Private GitHub repo when pushed.

## Pipeline (`pipeline/`)
- Python, run by a jobd/cron job every 10 min on SCAR18.
- Sites: ~20 eastern-flyway NEXRAD IDs listed in `pipeline/sites.json`.
- Per site: list newest volume in `s3://unidata-nexrad-level2-chunks` (or
  `noaa-nexrad-level2` archive if chunks are unavailable), download, run
  `vol2bird` (Docker `adokter/vol2bird` or local build) to produce a vertical
  profile, reduce to {density (birds/km^3, column-integrated), heading (deg),
  speed (m/s), peak altitude (m), scan time}.
- Writes `public/data/birds.geojson` atomically (tmp + rename), one Point
  feature per site, plus a top-level `generated_at`. Last-good kept per site
  when a site fails; failures logged, never swallowed.
- Parallel over sites, max 8 workers. Wall time measured and logged.

## Globe layer (`src/data/birds.js`)
Follows `src/data/earthquakes.js`: fetches `data/birds.geojson` on
`updateInterval` 10 min; one column per radar (height by density, colour by
heading), tooltip with numbers and radar ID. Registered in `src/main.js`,
`src/data/layerState.js` registry, `src/data/dataCredits.js`, voice alias in
`src/voice/gevActions.js`. Daytime/no-migration state shows explicit "quiet"
text rather than an empty layer.

## Testing
- Unit: reducer + GeoJSON writer against a real vol2bird output fixture.
- Real-execution: pipeline run against one live radar; file lands; layer
  renders in the dev server.
- Negative + positive control in the same test: a corrupt volume fails loud,
  the good volume still produces a feature.

## Out of scope for M1
Whales, algal blooms, Pages deploy, historical playback, all 143 sites.
