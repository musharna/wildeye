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

## Field outputs (M2/M3)
- `public/data/birds_ppi/<SITE>.png` + bounds: lowest sweep reflectivity with rain
  masked (RHOHV < 0.95, −10..35 dBZ, 5–150 km), 0.01° grid, viridis ramp.
- `public/data/birds_field.png/.json`: 0.02° max-composite of all sites plus
  per-site `u_ms`/`v_ms`; the globe seeds 4,000 ensemble particles from it.
  These are gitignored (regenerated every 10 min).

## Europe: Aloft / BALTRAD profiles (CC0)
```bash
python3 -m pipeline.aloft --out public/data/aloft.geojson --workers 12   # cron daily 06:20
```
Lists the 187 radar prefixes in the Aloft bucket, downloads each radar's newest daily VPTS CSV,
takes the latest profile with data, and reduces it with the same reducer as NEXRAD. Radars with
no file this year (decommissioned) are listed in `failures`. Measured 2026-09-11: 144/187 in 26 s.
No drape for Europe: raw OPERA volumes are not redistributable; profiles are.

## Raster drapes (config-driven)
```bash
python3 -m pipeline.raster --out public/data        # cron daily 06:40; --only crw-bleaching,oisst
```
Products in `pipeline/rasters.json`: an ERDDAP `transparentPng` URL, bounds, an optional
`mode_color` post-process (makes the dominant opaque colour transparent, e.g. bleaching level 0),
legend and credit. Writes `public/data/rasters/<id>.png` + `rasters.json` (last-good kept per
product, marked `stale`). Measured 2026-09-11: ~209 s per product (ERDDAP redirect is slow).
Products: `crw-bleaching` (NOAA CRW Bleaching Alert Area, daily) · `oisst` (NOAA OISST v2.1; the
ERDDAP aggregation lags ~2 weeks).

## Replay archive (M5)
```bash
python3 -m pipeline.build_archive --start 2026-08-12 --end 2026-09-10 --hours 0-12 --workers 10
```
One frame per UTC hour → `public/data/birds_archive/YYYY/MM/DD/HH/{birds.geojson, field.png, field.json, drape.png}`
plus `manifest.json`. Scan nearest the hour within 20 min; a site with no scan is absent
from that frame (no last-good in history). Resumable: existing frames are skipped.
Measured 2026-09-11: 20 sites, 10 workers, 38 s and 1.2 MB per frame (drape.png ≈ 0.75 MB).
Gitignored; ~460 MB for 30 nights × 13 h.

## Measured
2026-09-10 23:04 EDT: 20 sites, 8 workers, 20 s wall, 20/20 fresh (vol2bird ≈5 s/volume).
2026-09-10 23:45 EDT: with PPI + field, 40 s wall, 20/20 fresh, 3.4 MB output.

## Limits
CONUS only (20 eastern-flyway sites in `sites.json`; 143 exist). Signal is
nocturnal and seasonal; daytime shows near-zero density, which the layer
labels "Quiet". vol2bird's biological filter is not perfect: heavy rain or
insects can leak through.
