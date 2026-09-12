# Biological data sources — plan of attack (v2, post-panel)

> v1 (d2fc6c6) was audited by a 6-judge panel on 2026-09-11; findings and what was
> verified live are in memory `wildeye_roadmap_panel_audit_2026-09-11.md`. v2 moves
> the first work _backwards_ into repairing the two shipped patterns v1 planned to
> clone, adds a fourth data contract, and leads tracks with a US-gov source.
> Roadmap, not a bite-sized plan; each wave gets its own plan when it starts.

**Goal:** integrate every viable source from the survey under the v1 policy
(CC0 / CC-BY / US-gov only; free non-commercial app) without inventing a
mechanism per source.

## Data contracts (four) and renderers

| Contract                                         | Fields                                                                                                    | Pipeline                     | Frontend                                                       | Exists?                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| **Gridded field** (daily)                        | PNG + lat/lon bounds, **plate carrée only**, explicit class/nodata mask, acquisition time                 | `raster.py` + `rasters.json` | `createRasterDrapeLayer`                                       | yes, needs Wave 0 repair                                    |
| **Occurrence** (record at lat/lon/date)          | taxon, date, lat/lon, ±uncertainty, publisher, datasetKey/DOI, per-record licence string, `truncated`     | `occurrences.py` → adapters  | `createOccurrencesLayer`                                       | yes, needs Wave 0 repair                                    |
| **Track** (ordered fixes per individual)         | `(source, study, individual[, deployment])`, segments `[{t, lon, lat}]`, gaps, licence, citation, embargo | **new** `tracks.py`          | **new** `tracks.js` (polyline + head, samples at selected UTC) | no — Wave 2                                                 |
| **Site series** (repeated value at a fixed site) | site, `[{t, value, unit, qc, effort}]`, measured-zero ≠ missing                                           | **new** `sites.py`           | **new** `siteSeries.js` (marker + sparkline/info box)          | no — Wave 3 (Aloft is NOT a precedent: latest profile only) |

Not contracts: **tiles** (Cesium imagery provider, zoom-level attribution — never a
`rasters.json` row), **polygons/coverage** (HPAI counties, ranges: needs an
acknowledged contract before any polygon source ships), **audio** (media URL on a
record, player in the info box). Columns / PPI / particles are renderer variants.

Hard rules (all shapes): per-record or per-study licence filter in the pipeline;
publisher + DOI/citation survive to the info box and `dataCredits.js`; never
de-obscure and, for tracks, publication lag + sensitive-taxon exclusion; no
credentials in the browser; each source row records terms URL + date read;
re-verify terms before each new wave; `DATA_SOURCES.md` row is the ledger.

## Wave 0 — repair the shipped patterns (no new sources)

| Item                                                                                                                                                                                                                                                                                                                                  | Why (verified)                                             | Status                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------- |
| Occurrences provenance: keep `publishingOrgKey`/publisher name, `datasetKey`, DOI, `coordinateUncertaintyInMeters`; show the real licence string, not "CC-BY" for everything; register a GBIF derived-dataset DOI or cite per publisher (we use the search API, the ledger claims a download DOI)                                     | `occurrences.py:86-96`, `occurrences.js:43`, matrix row    | **done e4d5e97 (derived-dataset DOI still open)** |
| `truncated: true` per taxon when the 600 cap bites (3 taxa sit at exactly 600)                                                                                                                                                                                                                                                        | `occurrences.py:60`                                        | **done e4d5e97** |
| Drapes: explicit class/nodata mask per product replacing most-frequent-colour heuristic; deterministic z-order + one-drape-at-a-time picker; on-map discrete legend; bleaching row labelled **legacy 0–4** (CRW site now runs Alert Levels 1–5, ERDDAP var still 0–4)                                                                 | `raster.py:14`, `rasterDrape.js:51,70`, `rasters.json:6`   | **done 174c2ef (z-order + legends) + picker: `drapeExclusive.js`, last request wins** |
| Raster archive: keep dated PNGs + manifest history for products that should replay (needed before any "pairs with slider" claim)                                                                                                                                                                                                      | `raster.py` writes one PNG per product                     | **done 174c2ef + 7377869** |
| Shared **observed-time selector** `{instantUTC, window, playing, speed}` that layers sample: birds map to nearest archive frame (particles stay wall-clock), tracks interpolate inside segments, rasters pick acquisition, occurrences age from selected time. Not the birds widget lifted out; rockets' mission clock stays separate | `birds.js:204-207, 337, 399-470`, `rocketLaunches.js:1888` | **done a78cdd7 (`src/observedTime.js`)** |
| Birds manifest memoised for page life + `range.max` frozen → open session never sees new frames                                                                                                                                                                                                                                       | `birds.js:400, 452`                                        | **done fcec0c8** |
| Storage policy: tracked `occurrences.geojson` (1.5 MB) rewritten daily; decide gitignore-all-output + seed-on-clone before Waves 2–3 multiply it                                                                                                                                                                                      | `.gitignore`                                               | **done e664c1b (seeds, `npm run seed`)** |

## Gate 0 — per-product verification (runs alongside Wave 0)

**Status 2026-09-11:** 20 rows read and graded in `DATA_SOURCES.md` (8ae4dc6). Unreadable by fetcher: Reef Life Survey (403), Kelp Watch (JS app) — need a browser read.

Per product, not one global blocker: licence as read (URL + date), endpoint,
sample payload, temporal coverage, projection, redistribution right,
attribution string, `v1 / v2 / no`. Start the human-latency asks now: NEFSC email
for RWSAS; Movebank account is optional (see Wave 2). Already verified live
2026-09-11: USA-NPN CC BY 4.0; iNat-via-GBIF per-record CC0/CC-BY (3.4 M records
in 2026); EOD (eBird) via GBIF CC-BY but ends 2024-12-31; Xeno-canto API needs
key; NEON API needs token; WastewaterSCAN CC BY-NC + contact gate; ATN ERDDAP
live with "may be used and redistributed" licence text; NCEI NDVI THREDDS has WMS.
Still to read: Allen Coral Atlas FAQ/terms, OBIS-SEAMAP terms, KelpWatch (ODbL?),
USF Sargassum, Whale Safe, Columbia DART, APHIS ArcGIS service, CDC NWSS, PhenoCam,
Reef Life Survey, GFW per-layer.

## Wave 1 — gridded fields, zero credential

| Product                                    | Notes                                                                                                                                                                                                                  | Status          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| CRW `CRW_DHW`, `CRW_HOTSPOT`, `CRW_SEAICE` | same `NOAA_DHW` griddap as shipped BAA (variables verified); continuous fields → need the Wave 0 mask, not mode-colour                                                                                                 | **done 8ee51e5** |
| NDVI (NOAA CDR, VIIRS daily)               | `ncei.noaa.gov/thredds/.../cdr/ndvi/<year>/` exposes **WMS**; probe `GetMap` once — if it renders, it is a `rasters.json` row; else needs a netCDF→PNG mode. Not on CoastWatch ERDDAP. Replay needs the raster archive | **done 8ee51e5** (WMS GetMap 3.7 s, catalog resolver) |
| Sea ice                                    | use `CRW_SEAICE`; the NSIDC ERDDAP product is EPSG:3411 metres and cannot be draped as a lat/lon rectangle                                                                                                             | **done 8ee51e5** |
| NOAA HAB                                   | split into named regional products (Gulf of Mexico, Lake Erie) after Gate 0; bulletin-only ones go to polygons or drop                                                                                                 | open: named regional products not yet identified |
## Wave 2 — track contract (ATN first, then Movebank)

**Status 2026-09-11:** ATN **shipped 6adbb55** (572 segments / 62 deployments / 7 species). Movebank pilot **needs an account** to read `license_type` (study list is 401 unauthenticated). OTN **parked**: species needs a three-table join and the ERDDAP timed out on aggregate queries.

1. **IOOS ATN DAC ERDDAP** (`atn.ioos.us/erddap`, tabledap per deployment, US-gov,
   no login, no handshake): enumerate `*_trajectory_*` datasets, verify per-dataset
   licence text, build `tracks.py` + `tracks.js` against it. Archival data, so the
   observed-time selector is exercised from day one.
2. **Movebank, curated pilot** (1–3 public studies with explicit CC0/CC-BY
   `license_type` + citation; allowlist reviewed by hand): public JSON endpoint
   works unauthenticated; fetch **serially** (1 concurrent request per IP — never
   copy `ThreadPoolExecutor(4)`); no offset paging — partition by individual ×
   UTC window, dedupe boundaries, never use `max_events_per_individual` as a page;
   handle `license-md5` + cookie handshake and reject HTML bodies; key on
   `(study_id, individual_local_identifier, deployment)`; filter `visible=false`;
   segment on gaps/deployment changes/impossible speeds; split at ±180 for export;
   drop or point-fallback individuals with <2 fixes; sampling budget preserves
   endpoints/turns (≤1 pt/h is a display budget, not a rule); publication lag +
   sensitive-taxon exclusion; per-study citation into `dataCredits.js`.
3. **OTN detections** (CC-BY; ERDDAP public): render as **detection events at
   receivers** with optional dashed inferred links — never solid paths.
4. v2 shelf for the same contract once terms are read: seaturtle.org. OCEARCH
   declined (personal-use tracker, no API).

## Wave 3 — occurrence adapters, site series, polygons

**Status 2026-09-11:** USA-NPN **shipped 673c9de**; iNaturalist CC0/CC-BY subset already flows via GBIF (ledger). Site-series and polygon contracts not started: NEON needs a token; DART/APHIS need replies; **Polygon contract shipped with CDC NWSS** (`pipeline/wastewater.py` + `src/data/wastewater.js`, token `2`): 778 counties, per-site 15-day median-log trend rolled up by population; the ledger's 2ew6-ywp6 was archived 2025-09-12, successor j9g8-acpt carries an explicit US-gov licence. APHIS HPAI can reuse the same county shapes once their service is confirmed.

**Occurrence adapters** (shared runner + per-source adapter with schema + fixture,
not a declarative JSON normaliser): USA-NPN observations (CC BY 4.0, citation
string); iNaturalist CC0/CC-BY subset via GBIF `datasetKey` (media excluded);
EOD-via-GBIF as a **historical** bird layer (ends 2024) if wanted; Reef Life
Survey as effort-aware survey records after Gate 0; NOAA RWSAS after NEFSC reply.

**Site-series contract** (new): NEON (CC BY 4.0, token → credentials server-side)
as the reference source, then Columbia DART / ADF&G salmon counts, USGS NWIS +
GLERL (context only), PhenoCam, CDC NWSS (separately assessed from WastewaterSCAN).

**Polygon contract** (new): USDA APHIS HPAI wild-bird detections from their ArcGIS
service (county polygons, not centroids, not an HTML scrape); RESOLVE ecoregions
(CC-BY) as a biome skeleton if wanted.

## Wave 4 — credentialed

Xeno-canto (API key; per-recording CC0/CC-BY only, SA/NC/ND out; hotlink audio,
attribute recordist); NEON token (above); Copernicus Marine **O₂ / pH only** —
the chlorophyll-coverage rationale was wrong, our VIIRS product is already DINEOF
gap-filled — and its custom licence needs an explicit policy exception or it is
out; NASA CyAN (Earthdata); Global Forest Watch split per layer (CC-BY ones only);
Allen Coral Atlas benthic/geomorphic classes only via a tile provider, mosaic is
NC-SA, and the site's automated-retrieval / whole-dataset consent clause must be
cleared first.

## Shelf (v2 / policy decision) and declined

Shelf: GFW NC layers, OBIS-SEAMAP non-CC0 datasets (site terms restrict
redistribution even of CC-BY downloads — panel-cited, unread by me), KelpWatch
(ODbL — panel-cited, unread), BirdCast images, IUCN ranges.
Declined: eBird API channel (personal NC, no bulk cache), BirdWeather (rights
granted to Scribe, users personal-NC), WastewaterSCAN (CC BY-NC + contact gate),
Protected Planet (redistribution ban, not an NC question), Whale Safe, OCEARCH,
Motus, Happywhale, GISAID, ProMED/HealthMap, Wildlife Insights, Argos portals.
Not biological, dropped: Argo.

## Definition of done, per wave

JS + pipeline tests green; `npx vite build`; cron wrapper run once under
`env -i PATH=/usr/bin:/bin HOME=$HOME` (wrappers pin miniconda); layer `update()`
driven over the live file in node; browser smoke of enable/disable/replay;
source-age + last-good behaviour visible; payload budget stated; ledger row in
`DATA_SOURCES.md` with terms URL + date; credit + voice alias; `docs/CURRENT-STATE.md`
layer count.
