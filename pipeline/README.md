# wildeye pipeline — birds on radar

Turns the newest NEXRAD Level II volume per radar into one migration record
per site, written to `public/data/birds.geojson` for the `birds` globe layer.

## Prerequisites
- Docker (image `adokter/vol2bird`, pulled on first run)
- Python 3.11+ with `boto3` (anonymous S3; no AWS credentials needed)

## Run
```bash
python3 -m pipeline.build_birds --out public/data/birds.geojson --workers 8   # all sites
python3 -m pipeline.build_birds --out public/data/birds.geojson --sites 2     # smoke
python3 -m pytest pipeline/tests -q
```
Cron (every 10 min): `pipeline/run_birds.sh >> pipeline/cron.log 2>&1`.
Downloads cache in `$WILDEYE_WORK` (default `/tmp/wildeye-nexrad`).

## Output schema (`properties` per Point feature)
| key | meaning |
|---|---|
| `site`, `name` | NEXRAD id and city |
| `density_birds_km3` | mean vol2bird `dens` over 0–3000 m bins (null = no signal) |
| `heading_deg` | density-weighted circular mean of `dd` |
| `speed_ms` | density-weighted mean of `ff` |
| `peak_altitude_m` | height bin with max density |
| `scan_time` | volume timestamp, UTC ISO |
| `stale` | true when this run failed for the site and the last good record was kept |
Top level: `generated_at`, `site_count`, `fresh_count`, `failures` (site → error).

## Measured
2026-09-10 23:04 EDT: 20 sites, 8 workers, 20 s wall, 20/20 fresh (vol2bird ≈5 s/volume).

## Limits
CONUS only (20 eastern-flyway sites in `sites.json`; 143 exist). Signal is
nocturnal and seasonal; daytime shows near-zero density, which the layer
labels "Quiet". vol2bird's biological filter is not perfect: heavy rain or
insects can leak through.
