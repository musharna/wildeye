# Biological data sources — plan of attack

> Roadmap, not a bite-sized TDD plan. Each wave gets its own implementation plan
> when it starts. Status column is the ledger; update inline.

**Goal:** integrate every viable source from the 2026-09-11 survey into wildeye
without adding a third layer mechanism. Everything lands as one of three shapes
that already exist:

| Shape                                             | Pipeline                                                       | Frontend                                                                 | Adding a source costs                                        |
| ------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Raster drape** (gridded, daily)                 | `pipeline/raster.py` + row in `rasters.json`                   | `createRasterDrapeLayer` in `src/data/rasterDrape.js`                    | 1 JSON row + 1 export + registry token + credit              |
| **Point feed** (records with lat/lon/date)        | `pipeline/occurrences.py` pattern → own module writing GeoJSON | `createOccurrencesLayer` pattern (group chips, age alpha)                | 1 fetch/normalise module + layer file                        |
| **Track feed** (ordered positions per individual) | **new, wave 2** — `pipeline/tracks.py`                         | **new** `src/data/tracks.js` (polyline + head marker + time-slider hook) | built once for Movebank, reused by OTN/OCEARCH-class sources |

Hard rules carried from the licence pass (DATA_SOURCES.md):

- CC0 / CC-BY / US-gov only in v1. NC or unread terms → v2 column, not shipped.
- Per-record licence filter in the pipeline, credit per publisher, never de-obscure.
- No credentials in the browser; keyed sources fetch server-side in cron.
- Every layer: registry token, `dataCredits.js` entry, voice alias, ledger row,
  **update() driven over the live file in node before "shipped"** (LOAD FAILED 09-11).

## Gate 0 — licence verification sweep (before any code)

One subagent brief, live pages only, output = rows appended to the licence matrix.
Sources: Xeno-canto, BirdWeather, USA-NPN, Allen Coral Atlas, NSIDC sea ice,
USF Sargassum, Kelp Watch, NASA LP DAAC NDVI (or NOAA ERDDAP VIIRS NDVI),
Global Forest Watch, USGS NWIS, NOAA GLERL, Columbia DART, WastewaterSCAN,
USDA APHIS HPAI, Reef Life Survey, Whale Safe, BirdCast, eBird (browser read),
Protected Planet, OBIS-SEAMAP. Each row: licence as read, URL, conditions,
attribution string, `v1 / v2 / no`. Un-fetchable = "could not fetch", never guessed.

## Wave 1 — zero-credential rasters (rasters.json rows only)

| Source                                                                    | Product                        | Why                                                 | Status                        |
| ------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------- | ----------------------------- |
| NOAA CRW                                                                  | Degree Heating Weeks + HotSpot | same ERDDAP as bleaching; two legend-clear products | pending                       |
| NOAA/NASA VIIRS NDVI (ERDDAP `nesdisVHNnoaaSNPPnoaa20...NDVI` or similar) | greening wave                  | pairs with replay slider                            | pending, verify dataset id    |
| NSIDC / NOAA sea-ice concentration (ERDDAP)                               | polar habitat                  | context for polar-bear sightings                    | pending                       |
| NOAA HAB forecast grids (where gridded)                                   | blooms                         | Gulf/Lake Erie                                      | pending, may be bulletin-only |

Also in this wave: **on-map colour legend for drapes** (task #4) — bleaching needs
the discrete 4-step palette; do it once for all drapes before adding four more.

## Wave 2 — track feed (new shape; Movebank first)

1. User creates a Movebank account; credentials to `pipeline/.env` (gitignored).
2. `pipeline/tracks.py`: list public-download studies with licence CC0/CC-BY,
   pull last N days per individual, downsample to ≤1 pt/h, write
   `public/data/tracks.geojson` (LineString per individual + `times[]`).
3. `src/data/tracks.js`: polyline + current-position marker, species chips,
   time-slider integration with the existing replay controller (birds layer owns it
   today — extract a shared `replayClock` first if coupling is ugly).
4. Reuse for **OTN detections** (CC-BY; retry ERDDAP), which are sparse
   detections not GPS — render as receiver-hop segments.
5. v2 candidates for the same shape once terms are read: OCEARCH, seaturtle.org.

## Wave 3 — point feeds (occurrences pattern)

| Source                               | Notes                                            | Status       |
| ------------------------------------ | ------------------------------------------------ | ------------ |
| Xeno-canto                           | per-recording CC; add audio play in the info box | after Gate 0 |
| USA-NPN phenology observations       | leaf-out/bloom points; monarch/milkweed          | after Gate 0 |
| BirdWeather station detections       | live acoustic bird IDs                           | after Gate 0 |
| Reef Life Survey                     | CC-BY download, not API — snapshot pipeline      | after Gate 0 |
| USDA APHIS HPAI wild-bird detections | county-level, table scrape                       | after Gate 0 |
| WastewaterSCAN / NWSS                | site points with pathogen trend                  | after Gate 0 |
| NOAA RWSAS right whales              | only after NEFSC email reply                     | blocked      |
| Columbia DART / ADF&G salmon counts  | site points with daily count                     | after Gate 0 |
| USGS NWIS water temp / GLERL buoys   | sensor points; context, low priority             | after Gate 0 |

Do these as **one config-driven `pointFeed` pipeline** (`pipeline/pointfeeds.json`
→ `pipeline/pointfeed.py`), each source a normaliser function, one GeoJSON per
source, one `createPointFeedLayer(cfg)` factory. Occurrences stays as is.

## Wave 4 — credentialed rasters

- **Copernicus Marine** BGC (chl, O2, pH): registration, credentials server-side;
  adds global coverage the NOAA VIIRS product lacks in cloudy regions.
- **NASA CyAN** freshwater cyanobacteria: Earthdata login.
- **Global Forest Watch** GLAD alerts: key; tree-cover loss as disturbance.
- **Allen Coral Atlas** benthic tiles: CC-BY, tile service — likely an imagery
  provider, not a PNG drape.

## Wave 5 — v2 / non-commercial shelf

iNaturalist, Global Fishing Watch, OBIS-SEAMAP NC datasets, Protected Planet,
IUCN ranges, BirdCast images, eBird. Build only under an explicit NC release
policy decision; never mixed into the v1 ledger.

## Declined (do not revisit without new terms)

Motus, Happywhale, GISAID, ProMED/HealthMap, Wildlife Insights, Argos portals.

## Ordering rationale

Gate 0 first because the survey's licence claims are unverified and the last pass
found two "obvious" sources (eBird, RWSAS) un-shippable. Wave 1 is cheapest and
ships the legend fix everyone needs. Wave 2 is the only new mechanism and the
biggest visible gap (nothing moves yet). Wave 3 is volume. Wave 4 needs accounts.

## Per-wave definition of done

tests green (JS + pipeline), `npx vite build`, cron line installed and **run once
under `env -i PATH=/usr/bin:/bin`**, update() driven over the live file, ledger
row + credit + voice alias, `docs/CURRENT-STATE.md` layer count bumped.
