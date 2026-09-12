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
Products in `pipeline/rasters.json`: an ERDDAP `transparentPng` URL, **lat/lon bounds (plate
carrée only — a polar-stereographic product cannot be draped this way)**, `transparent`
(`"none"` or `{"rgb": [r,g,b]}` — the *pinned* no-data/class-0 swatch; the build raises
`PaletteChanged` if that colour is absent, so a palette change fails loud instead of hiding a
real class), `classes` (discrete legend, `hidden` marks the masked class) or `ramp`
(`min/max/unit/log/stops` for a continuous legend), `zrank` (stacking: continuous fields low,
class overlays high), legend text and credit. Writes `public/data/rasters/<id>.png` +
`rasters.json` (last-good kept per product, marked `stale`; `masked_fraction` logged), and
archives every new acquisition to `rasters/<id>/<stamp>.png` (`keep_days`, default 30) listed
as `history` in the manifest — the frontend drape shows the archived acquisition at the shared
observed time. Measured 2026-09-11: ~209 s per product (ERDDAP redirect is slow).
Products: `crw-bleaching` (NOAA CRW Bleaching Alert Area, daily) · `oisst` (NOAA OISST v2.1; the
ERDDAP aggregation lags ~2 weeks) · `chlor-a` (NOAA VIIRS gap-filled chlorophyll-a, log scale, daily NRT).
Requests carry a wildeye User-Agent: the ERDDAP redirect target (coastwatch.noaa.gov) returns 403 to Python-urllib.
`--only X` leaves the other products' manifest entries untouched.

## Wildlife sightings: GBIF + OBIS (CC0 / CC-BY records only)
```bash
python3 -m pipeline.occurrences --out public/data/occurrences.geojson --days 120 --workers 4   # cron daily 06:50
```
Taxa in `pipeline/taxa.json` (id, name, GBIF taxonKey, scientific name for OBIS, group, icon). GBIF is
filtered server-side (`license=CC0_1_0,CC_BY_4_0`, coordinates, no geospatial issues, ≤600/taxon);
OBIS is filtered here on the per-record `license` (NC/SA/all-rights-reserved dropped). Same taxon +
day + 0.001° cell is deduped across sources. Output: FeatureCollection with `generated_at`, `window_days`,
`counts` per taxon, `failures`, `taxa`. Lookback is 120 d because OBIS ingestion lags months (0 humpback
records in the last 30 d, 2368 in 120 d). Measured 2026-09-11: 3364 records, 11 taxa, 21 s, 1.5 MB.
Right whale = 0 (NOAA sightings are email-only, not in GBIF/OBIS).

## Replay archive (M5)
```bash
python3 -m pipeline.build_archive --start 2026-08-12 --end 2026-09-10 --hours 0-12 --workers 10
```
One frame per UTC hour → `public/data/birds_archive/YYYY/MM/DD/HH/{birds.geojson, field.png, field.json, drape.png}`
plus `manifest.json`. Scan nearest the hour within 20 min; a site with no scan is absent
from that frame (no last-good in history). Resumable: existing frames are skipped.
The globe reads frames through the shared observed-time bar (`src/observedTime.js`): birds
show the newest frame at or before the selected hour; the manifest is re-read on every live
poll so frames the cron appends reach an open session.
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

## Storage policy (2026-09-11)
Live outputs in `public/data/` (`birds.geojson`, `aloft.geojson`, `occurrences.geojson`,
`rasters/`, `rasters.json`, `birds_field.*`, `birds_ppi/`, `birds_archive/`) are rewritten by
cron and **gitignored** — a 1.9 MB file rewritten daily must not enter git history. Small
seed snapshots live in `public/data/seed/` (birds, aloft, a 40-per-taxon occurrences subset)
and `pipeline/seed.sh` copies any missing live file into place, so a fresh clone still shows
data before the first cron run. Refresh a seed deliberately (`cp` + commit), never by cron.
Budget: a tracked seed stays under ~100 KB; new feeds (tracks, site series) follow the same
split and state a payload cap in their README section.

## Animal tracks: IOOS ATN (track contract)
```bash
python3 -m pipeline.tracks --out public/data/tracks.geojson            # cron weekly Mon 07:00 (archival source)
python3 -m pipeline.tracks --limit 3 --out /tmp/t.geojson              # smoke
```
Sources in `pipeline/tracks.json` (`kind: erddap`): newest `max_per_species` deployments per
species from an ERDDAP search; fixes are fetched **serially** (one request in flight), invalid
Argos class `Z` and fixes implying > `max_speed_ms` are dropped (the later fix, never the
earlier), a publication lag of `min_age_days` hides recent positions, the display budget keeps
one fix per `min_gap_s` plus endpoints, segments split on gaps > `segment_gap_h` and at the
antimeridian (crossing point inserted at ±180). One LineString per segment with a parallel
`times[]` (length validated). Per-deployment `license`, `citation`, `institution`, `url`
ride into the info box. Measured 2026-09-11: ~2 s per deployment.

**Movebank** (`kind: "movebank"` source in `tracks.json`, `pipeline/movebank.py`): curated
public studies only. Credentials come from `MOVEBANK_USER` / `MOVEBANK_PASS`, which
`run_tracks.sh` sources from `~/.config/wildeye/env` (mode 600, outside the repo). Per study:
metadata, individuals → taxon, visible GPS events since `days` (60) ago; one dataset per
individual (`mb:<study>:<individual>`) through the same clean / lag / downsample / segment
path. The study's `license_type` is read from Movebank on every run and anything but `CC_0`
/ `CC_BY` is refused even if listed. A licence page in place of CSV is accepted once via the
`license-md5` re-request; a second licence page is an error. `common` maps canonical taxa to
display names, `default_species` covers individuals with no taxon. Measured 2026-09-11:
3 studies, 32 individuals, 78 segments, 20 s.

## GBIF derived-dataset DOI (sightings layer)
```bash
python3 -m pipeline.gbif_derived --source-url https://<hosted wildeye>/            # dry run: prints the payload
set -a; . ~/.config/gbif/credentials; set +a; GBIF_USER=$username GBIF_PASS=$password \
  python3 -m pipeline.gbif_derived --source-url https://<hosted wildeye>/ --register   # mints the DOI, appends public/data/seed/gbif_derived.json
```
Registers the GBIF subset of `occurrences.geojson` (every `dataset_key` with its record count) as
a derived dataset so contributing datasets get credit. **Not yet registered**: the record needs a
public `sourceUrl`, so it waits for the hosting decision. Re-register when the taxon set changes,
not on every daily refresh.

## Acoustic detections: Ocean Tracking Network (site-series contract)
```bash
python3 -m pipeline.otn --out public/data/otn.geojson                 # cron weekly Sun 07:20
python3 -m pipeline.otn --weeks 8 --lookback-days 400 --out /tmp/o.geojson   # smaller pull
```
Pulls every public detection since `--lookback-days` from `erddap.oceantrack.org`
(`view_otn_aat_detections_stations_projects`, six narrow columns — the licence/citation
strings are ~700 B per row and are fetched once per project instead) plus the whole tag-release
view (`transmittername → species`, ~12 MB). Species is the join on transmitter name; detections
whose transmitter has no public release are dropped and counted (`counts.unjoined`, 2 % on
2026-09-11). One Point per receiver station (project + platform name + 4-dp position) with up to
`--weeks` 7-day bins ending on the newest public detection: `{w, n:{species:count}, a:animals}`.
Never issue an aggregate query (`distinct()`, `orderBy…`) against the detections view: the
gateway 504s. The gateway also returns 503 for stretches; `_get_json` retries 5xx four times
with 30/60/120 s backoff. Public data end about a year before today (collaborator embargo);
`data_end` is in the file and the client states it. Measured 2026-09-11: 112 k rows / 80 MB
before column trimming, ~60 s for the detections query. Licence CC BY 4.0 (OTN Data Policy
2024 §4a); OTN asks to be notified of data products.

## Avian influenza in wild birds: USDA APHIS (polygon contract)
```bash
python3 -m pipeline.hpai --out public/data/hpai.geojson            # cron daily 07:05 (APHIS updates the CSV weekly)
python3 -m pipeline.hpai --csv /tmp/hpai-wild-birds.csv --today 2026-09-11 --weeks 4 --out /tmp/h.geojson   # offline smoke
```
Downloads the CSV the APHIS wild-bird page embeds (`data-csv-url`; ~2 MB, one row per confirmed
detection since 2022 with state, county, dates, strain, species, WOAH class, sampling method).
Counties are matched by normalised (state name, county name) against the Census 2021 boundary
file shared with `wastewater.py` (`load_county_shapes(zip, None)` loads every county);
unmatched names are counted and logged, never guessed ("Unknown" county rows and Alaska's
dissolved Valdez-Cordova, 0.7 % on 2026-09-11). One polygon per county with ≥ 1 detection in
the last `--weeks` 7-day bins ending today: `weeks:[{w, n, captive, sp}]` plus `n_all` and
top species since 2022. Public domain (U.S. Government work).

## Wastewater virus trend: CDC NWSS (polygon contract)
```bash
python3 -m pipeline.wastewater --out public/data/wastewater.geojson          # cron weekly Sat 07:10 (CDC publishes Fridays)
python3 -m pipeline.wastewater --weeks 2 --today 2026-09-11 --out /tmp/w.geojson   # smoke
```
Pulls SARS-CoV-2 sample rows from `data.cdc.gov` j9g8-acpt (Public Domain U.S. Government;
2ew6-ywp6 in the ledger was archived 2025-09-12), server-side excluding `source = WastewaterSCAN`
(CC BY-NC). CDC's own footnote says concentrations are not comparable across sites, so each site
gets a trend against **its own** history: difference of the median log10(c+1) over the 15 days
ending at each week end and the 15 days before, clamped to ±2 (means gave ±6 artefacts from
non-detect zeros and unit slips). Counties take the population-weighted mean of their sites'
trends; a site listing several counties counts in each. Eight weekly values per county feed the
shared observed-time bar. Polygons come from the Census 2021 1:20m boundary zip (cached in
`$WILDEYE_CACHE`, default `~/.cache/wildeye`; 2022+ vintages replaced Connecticut's counties with
planning regions CDC does not use), coordinates rounded to 3 dp, only counties with data emitted.
Needs `pyshp` (imported lazily; module import stays stdlib). Measured 2026-09-11: 17.8k rows,
1135 sites, 778 counties, 0.6 MB, ~2 s.
