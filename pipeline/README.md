# wildeye pipeline — birds on radar

Turns the newest NEXRAD Level II volume per radar into one migration record
per site, written to `public/data/birds.geojson` for the `birds` globe layer.

## Prerequisites
- Docker (image `adokter/vol2bird` pinned by digest in `vol2bird.IMAGE`, pulled on first run)
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
| `vid_birds_km2` | birds per km² of ground, whole column: Σ `dens`·Δh (bioRad `integrate_profile` vid) |
| `mtr_birds_km_h` | migration traffic rate, birds crossing 1 km per hour: Σ `dens`·`ff`·3.6·Δh (bioRad mtr; gap bins drop out) |
| `speedless_share` | part of `vid` in gap bins with no `ff`, which `mtr` cannot count (null when `vid` is 0) |
| `bio_gate_share` | Σ `n_dbz` / Σ `n_dbz_all`: share of the reflective gates vol2bird kept as birds after its dual-pol rain filter and clutter screen (near 0 in rain, where `dens` rests on the few gates left; ~0.6–0.9 on a clear night; null with no echo). Below 0.55 the globe marks the scan as mostly not birds (threshold checked against airport rain gauges: `docs/analysis/bird-rain.md`) |
| `scan_time` | volume timestamp, UTC ISO |
| `stale` | true when this run failed for the site and the last good record was kept |
Top level: `generated_at`, `site_count`, `fresh_count`, `failures` (site → error).

Each scan's raw vol2bird output is kept in `--vp-dir` (default `~/.cache/wildeye/vp/SITE/YYYYMMDD/*.txt.gz`,
60 days). bioRad reads it as is: `Rscript pipeline/biorad_golden.R SITE out.csv <files>` writes bioRad's
vid/mtr/mt for the same profiles (the tests' golden numbers come from this, bioRad 0.12.0).

## Night totals (`public/data/birds_nights.json`)
Every bird run rebuilds tonight and last night for each site from the profile store (`pipeline/bird_nights.py`).
Night D runs from bioRad's sunset on D to its sunrise on D+1 (sun 0.268° below the horizon; `biorad_sun_golden.R`
checks the port). Per site and night: `mt_birds_km` (birds crossing 1 km over the night, bioRad mt),
`peak_mtr_birds_km_h` and `peak_time`, `profiles`, `coverage` (share of the night the profiles stand for),
`speedless_share` (share of the night's birds with no speed, which mt cannot count), `bio_gate_share`
(the profiles' share weighted by the time each stands for: the night's rain readout), `height_quartiles_m` (the
25th, 50th and 75th percentile heights of the night's birds, m ASL: bioRad's `integrate_profile(height_quantile)` rule
on every profile's density pooled, each weighted by the time it stands for; `biorad_height_golden.R` checks the port),
`antenna_m` (the radar's antenna height, read from its Level II header into `sites.json`), `complete` (sunrise passed).
Kept 60 nights; a site-night that fails is listed in `failures` and the rest still written.
The globe's radar popup shows tonight (once the sun has set) and the last complete night from this file: mt, peak
mtr and its time, marked "mostly rain or clutter" when the night's `bio_gate_share` < 0.55 (the scan threshold of
`docs/analysis/bird-rain.md`; checked separately on the night's weighted share: balanced accuracy 0.83) and with its coverage when a complete night is
under half covered. A finished night not marked rain carries "± 8% from 10-minute sampling" (`docs/analysis/bird-sampling.md`:
the cadence's error only, not calibration). Below them, the last 14 complete nights as a log-scale text sparkline
(× = mostly rain, · = no scans). A finished night not marked rain also says where its birds flew: "Half of last
night's birds flew 200–600 m above sea level (median 350 m; radar at 77 m)", rounded to 50 m (the bins are 200 m).
Replay frames show no night lines.
Past nights from the archive: `python3 -m pipeline.bird_nights backfill --site KOKX --night 2026-10-16`
(~140 volumes a night, vol2bird in Docker); `build` recomputes nights from what is stored.

## Seasons (`public/data/birds_seasons.json`)
`birds_nights.json` keeps 60 nights and the profiles behind them are pruned, so whole migration seasons are kept
in an append-only archive (`pipeline/bird_seasons.py`): each bird run freezes every site-night of a season (fall =
Aug 1 – Nov 15, BirdCast's window) 6 h after its sunrise, storing `mt_birds_km`, `bio_gate_share` and `coverage`, and
never rewrites a night already there. A night with no profiles is not stored. Backfilled stores are added with
`python3 -m pipeline.bird_seasons build --vp-dir <store> --season fall-2025 --out <file>`. The popup's season line
totals the stored nights and says how many of the season's nights so far it rests on and how many were mostly rain.
A comparison with last fall is shown only if `pipeline/season_check.py` finds adjacent radars agree on the change
between years (median pair disagreement ≤ 1.5× over ≥ 6 of the 11 pairs; `SEASON_COMPARE` in `src/data/birds.js`).

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
Products: `crw-bleaching` (NOAA CRW Bleaching Alert Area, daily) · `oisst` (NOAA OISST v2.1 Preliminary,
`ncdcOisst21NrtAgg_LonPM180`, ~1 day behind; the Final aggregate lags ~2 weeks) · `chlor-a` (NOAA VIIRS gap-filled chlorophyll-a, log scale, daily NRT) · `crw-outlook` (NOAA CRW Four-Month Coral Bleaching Heat Stress Outlook v5, the newest weekly NetCDF issue at 60% and 90%, ~4 s; `pipeline/crw_outlook.py` also writes `rasters/crw-outlook.data.png` for the click readout).
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
insects can leak through. A scan with `bio_gate_share` < 0.55 is drawn faded and its popup says the count
is mostly rain or clutter (`docs/analysis/bird-rain.md`). Levels are not comparable between radars
(`docs/analysis/bird-pairs.md`, `bird-sectors.md`): read each radar against its own nights.

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
metadata, individuals → taxon, visible GPS events inside the study's own window — exactly
one of `days` (active studies, back from the run) or `start` + `end` (archival, ≤ 366 days,
chosen as the 12 months with the most animal-hours) — sent to Movebank as
`timestamp_start` / `timestamp_end`; a study with both, neither, or a longer window fails the
build. One dataset per individual (`mb:<study>:<individual>`) through the same clean / lag /
downsample / segment path; `min_gap_s` per study overrides the source (archival 12 h, active
3 h, to fit the size cap). Fixes with no individual (undeployed tags) are dropped and counted,
never pooled; Homo sapiens individuals are refused; fixes dated after the run are dropped and
counted; at most `max_individuals` (12) per study are kept, those with the most fixes, ties by
id. The study's `license_type` is read from Movebank on every run and anything but `CC_0` /
`CC_BY` is refused even if listed. A licence page in place of CSV is accepted once via the
`license-md5` re-request; a second licence page is an error. `common` maps canonical taxa to
display names, `default_species` covers individuals with no taxon, `group` (one of the five
in `tracks.GROUPS`) colours the study; ATN species map to a group in the source's `groups`,
and a track with no group fails the build.

A study that errors is retried once at the end of the run; if it fails again its features
from the previous `tracks.geojson` are carried for up to 28 days after their last good fetch
(`failures[<key>].carried_from`), then dropped (`failures[<key>].dropped`). A study that
returns no tracks is flagged `failures[<key>].empty`. The whole Movebank phase has a
wall-clock budget (`--movebank-budget`, 1200 s): no attempt starts after it, and the rest are
carried — a blackholed network makes each request hang its full 120 s, and 13 studies × 2
attempts would otherwise pass `run_tracks.sh`'s 3000 s guard and kill the run before it writes
(measured 2026-09-25 with HTTPS sent to a dead proxy: budget 200 s → 2 attempts, all 13 carried). The build fails above `--max-bytes`
(6 MB). Recent data of a listed study may not be downloadable (Armenian gulls: listing says
2026-09, direct-read ends 2026-03), so an active study can come back empty. Measured
2026-09-25 (run_tracks.sh): 13 studies, 108 animals, 544 Movebank segments + 571 ATN, 24
species in 5 groups, 4.8 MB, 245 s.

## Ocean oxygen, pH and zooplankton: Copernicus Marine (raster drapes)
Three `cmems` rows in `rasters.json` (`cmems-o2` from `cmems_mod_glo_bgc-bio_anfc_0.25deg_P1D-m`, `cmems-ph`
from `…bgc-car…`, `cmems-zooc` from `…bgc-plankton…` variable `zooc`). A ramp with `"log": true` is spaced
evenly in log10 between `min` and `max` (`cmems-zooc`: 0.05–5 mmol C/m³; ramps without it are unchanged). `pipeline.raster` opens the dataset lazily through the `copernicusmarine`
toolbox with `CMEMS_USER` / `CMEMS_PASS` (`run_rasters.sh` sources `~/.config/wildeye/env`), takes
the surface level of the newest day **at or before today** (the datasets run ~10 days into
forecast), flips north-up and renders through the row's `ramp` (NaN = land → transparent). Same
archive/history handling as the PNG products. Measured 2026-09-12: 19 s + 10 s; `cmems-zooc` 16 s and 0.84 MB a
day (2026-10-07). Credit line is the
one Copernicus requires ("Generated using E.U. Copernicus Marine Service Information") plus the
product DOI 10.48670/moi-00015.

## Dominant phytoplankton group: Copernicus-GlobColour (raster drape, monthly)
One `cmems_dominant` row in `rasters.json` (`cmems-pft`, dataset
`cmems_obs-oc_glo_bgc-plankton_nrt_l4-multi-4km_P1M`, doi 10.48670/moi-00279), routed by `pipeline.raster` to
`pipeline/cmems_pft.py`. It reads the newest month at or before today of the variables named by the row's classes
(DIATO, DINO, HAPTO, GREEN, PROKAR; not PROCHLO, a prokaryote), checks the 8640×4320 whole-globe grid, averages
each group over the 4 km pixels of every 0.25° cell where all five are present, and paints the largest in its class
colour (no such pixel: clear). The frame is stamped on the month's first day, so the daily cron re-uses it until the
next month is published; `keep_days: 400` keeps about 13 months on the time bar (the default 30 would delete a
monthly frame on its first run). Measured 2026-10-07: 21 s, 1.3 GB peak RSS, 76 KB PNG. Premise check (not
chlorophyll re-coloured) and an independent cell check: `python3 -m analysis.pft_premise`, `python3 -m
analysis.pft_cells` (results in `docs/analysis/`).

## Introduced species by checklist: GRIIS (polygon contract)
```bash
python3 -m pipeline.griis --out public/data/griis.geojson                  # cron 1st of month 06:20
python3 -m pipeline.griis --out /tmp/g.geojson --seed-out public/data/seed/griis.geojson
```
The Global Register of Introduced and Invasive Species as ISSG publishes it on GBIF: one Darwin Core
Archive per country, territory or island, downloaded once per version. Every ISSG checklist must be an
area register, a protected-area register (named in `protected_areas`, not drawn) or listed in
`NOT_A_REGISTER`, else the run raises. Per list: `introduced` = taxa present and introduced;
`invasive` by the list's own basis — `impact` (GRIIS isInvasive), `spread` (degreeOfEstablishment
D2/E or invasive/widespreadInvasive: US-RIIS, Belgium) or `not stated` (None). Any status, origin,
flag or degree value without a rule raises with the list's name. `pipeline/griis_areas.json` is the
reviewed area → Natural Earth map-unit table (GU_A3; the US split into USA-CONT/USA-AK/USA-HI); a list
missing from it raises, one mapped to `[]` is named in `not_drawn`. When GBIF adds a list, map it
there by hand. The run refuses a listing missing more than a tenth of the table's lists.

## Mangrove extent by country: Global Mangrove Watch (polygon contract)
```bash
python3 -m pipeline.gmw --out public/data/gmw.geojson                  # cron 1st of month 06:10
python3 -m pipeline.gmw --out /tmp/g.geojson --seed-out public/data/seed/gmw.geojson
```
GMW v4.1.12 country statistics (Zenodo record 21346457, CC BY 4.0): extent in hectares per year
1985–2025 with lower/upper 95% bounds, one sheet each; the xlsx is md5-checked against the record
and the run refuses a mismatch before writing. Shapes: Natural Earth 50m admin-0 MAP UNITS (split
overseas territories such as French Guiana from France), ISO3 from `ISO_A3` or `ADM0_A3` when -99.
4 small territories have no map unit (Europa, Glorioso, Bonaire, Chagos; 0.006% of extent) and are
written to `missing` and named in the layer's legend. Measured 2026-09-25: 125 countries, 745 KB, 7 s.
The seed is the 20 countries with the most mangrove (83% of 2025 extent), shapes simplified.

## Deforestation alerts: Global Forest Watch (polygon contract)
```bash
python3 -m pipeline.gfw --out public/data/gfw.geojson              # cron daily 07:40 (GFW versions the table daily)
python3 -m pipeline.gfw --weeks 4 --today 2026-09-12 --out /tmp/g.geojson
```
Needs `GFW_API_KEY` (`run_gfw.sh` sources `~/.config/wildeye/env`). Resolves the newest version
of `gadm__integrated_alerts__iso_daily_alerts` from the dataset metadata (never `latest`: its
307 redirect drops the key), then one SQL aggregate per week (`SUM(alert__count)`,
`SUM(alert_area__ha)` by `iso`, confidence != low). Two gateway traps: the `x-api-key` header
is matched case-sensitively and urllib capitalises it, so the key travels as a query parameter;
and unaliased `SUM()`s collapse into one `sum` key. Country shapes: Natural Earth 110m admin-0
(public domain, cached in `$WILDEYE_CACHE`), ISO3 from `ISO_A3` or `ADM0_A3` when -99; 36 small
island states have no 110m shape and are logged. Fill = alert area per 10,000 km² per week.
Measured 2026-09-12: 114 countries, 12 weeks, 15 s.

## Small mammals: NSF NEON (site-series contract)
```bash
python3 -m pipeline.neon --out public/data/neon.geojson                  # cron weekly Mon 07:30 (NEON releases provisional data monthly)
python3 -m pipeline.neon --limit 3 --months 3 --out /tmp/n.geojson        # smoke, ~5 s
```
Needs `NEON_TOKEN` (`run_neon.sh` sources `~/.config/wildeye/env`; 2,000 requests/hour with a
token). `/sites` lists which months of DP1.10072.001 each site has; for each site-month in the
last `--months` the basic `mam_pertrapnight` CSV is downloaded (one row per trap per night).
Trap-nights = rows with status 2–6 (status 1 = trap not set is not effort), captures = status 5,
distinct `tagID` = individuals, species from `scientificName`. One Point per site with a monthly
series; sites are only ever compared with their own history. Licence CC BY 4.0 (NEON changed
from CC0 on 2026-06-30). Measured 2026-09-12: 41 sites, 106 site-months, 112 s.

## Invasive aquatic species: USGS NAS (occurrence adapter)
Runs inside `pipeline.occurrences` with no credentials. `nas.er.usgs.gov/api/v2/occurrence/search`
filters by calendar `year` only, so every year the window touches is paged (`limit=2000`,
`offset`, until `endOfRecords`) and the full record date (`year`/`month`/`day`) is re-checked
against the window; rows without a full date, coordinates or a scientific name are dropped.
Group `invasives`, taxon id `nas:<scientific-name>`, basis carries the NAS group, record type,
population status and county; the record links to the species fact sheet. Public domain.
Measured 2026-09-12: 336 rows for 2026 in one 9 s page.

## Sound recordings: xeno-canto (occurrence adapter)
Runs inside `pipeline.occurrences` when `XENO_CANTO_KEY` is set (`run_occurrences.sh` sources
`~/.config/wildeye/env`; without a key the adapter logs a warning and contributes nothing).
Query `since:<window start> lic:by`, paged (≤ 20 pages, 1 s apart), every record re-checked
with `licence_ok` (CC0 / CC BY only — 0 CC0 and ~240 CC BY uploads per 120 d on 2026-09-12;
NC/SA/ND are the bulk and are dropped). `since:` is the upload date, so the recording date is
filtered to the window too. Group `sounds`, taxon id `xc:<genus>-<species>`, record links to the
xeno-canto page; audio is never rehosted.

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

## Wildlife die-offs: USGS WHISPers (polygon contract)
```bash
python3 -m pipeline.whispers --out public/data/whispers.geojson     # cron daily 07:15
python3 -m pipeline.whispers --weeks 4 --today 2026-09-12 --out /tmp/w.geojson
```
Pages `https://whispers.usgs.gov/api/eventsummaries/` (public, no key) with `ordering=-start_date`,
500 per page, until the first event older than the window; the API's date filters are ignored
server-side and undated events sort first (skipped). Each event carries its counties (FIPS),
species, diagnoses (suspect flag folded into the label) and `affected_count`. Per county: weekly
bins `{w, n, affected, sp}`, top species and diagnoses, and the 12 newest events for the info box;
an event spanning several counties counts in each. Shapes from the shared Census 2021 loader.
Measured 2026-09-12: 177 events / 157 counties over 26 weeks, 14 s.

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

## Biology gap layers (2026-09-12)
Each writes `public/data/<id>.geojson` (gitignored) and has a committed seed under `public/data/seed/`.
Licences and caveats per source are in `DATA_SOURCES.md`; `node scripts/qa-gap-layers.mjs --url <preview>` smokes all nine in the real app.

| id | module / runner | cron | source | key |
|----|-----------------|------|--------|-----|
| `arbonet` | `pipeline.arbonet` | daily 07:25 | CDC NNDSS weekly (data.cdc.gov `x9gk-5huc`), per state | none |
| `phenology` | `pipeline.phenology` | daily 07:35 | USA-NPN status & intensity, 6 requests/run | none |
| `neon-vectors` | `pipeline.neon_vectors` | Mon 06:05 (~4.5 min) | NEON DP1.10093 ticks + DP1.10043 mosquitoes | `NEON_TOKEN` |
| `cetaceans` | `pipeline.cetaceans` | Sun 07:30 | NOAA PACM static `detections.csv` per species theme | none |
| `drought` | `pipeline.drought` | Thu 07:10 | U.S. Drought Monitor weekly GeoJSON, 5 releases | none |
| `h5n1` | `pipeline.h5n1` | Mon 06:55 | Nextstrain open builds (USDA/GenBank), US only; GISAID builds declined | none |
| `fires` | `pipeline.fires` | 01/07/13/19:15 | FIRMS VIIRS global 7-day CSVs, 0.5° × 6 h | none |
| `ecoregions` | `pipeline.ecoregions` | 1st of month 06:00 | RESOLVE 2017 zip cached in `~/.cache/wildeye` | none |
| `gmw` | `pipeline.gmw` | 1st of month 06:10 | Global Mangrove Watch v4.1.12 country xlsx (Zenodo, md5-checked) + Natural Earth 50m map units, cached in `~/.cache/wildeye` | none |
| `griis` | `pipeline.griis` | 1st of month 06:20 | GBIF publisher listing for ISSG + one GRIIS Darwin Core Archive per checklist (cached per version in `~/.cache/wildeye/griis`) + Natural Earth 50m map units; area → unit table `pipeline/griis_areas.json` | none |
| `rivers` | `pipeline.rivers` | daily 06:45 | USGS OGC API `daily` (not legacy WaterServices) | optional `USGS_WATER_API_KEY` |
| `fishing` (not wired) | `pipeline.fishing` | — | GFW 4Wings effort | `GFW_FISHING_TOKEN` (not `GFW_API_KEY`) |
| `iucn` (badge, dormant) | `pipeline.iucn` | — | IUCN Red List v4 | `IUCN_TOKEN` |

Rivers sizes markers by flow magnitude: tidal gages report negative daily discharge, and an unguarded
`log10(q + 1)` produced a NaN point size that stopped Cesium's render loop (found by the real-app smoke).
