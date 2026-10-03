# Protected areas (OpenStreetMap via Overture) — design (2026-10-03)

Survey Tier B item after SEDAC and OBIS (grill `grill_wildeye_bio_interpolation_2026-09-29` Q16). Decisions: grill
`grill_wildeye_osm_protected_areas_2026-10-03` (delegated by the maintainer, "defer grilling to you"; build on "build").

## Outcome

Switch on **Protected areas (OpenStreetMap)**. Every protected area mapped in OpenStreetMap is painted on the globe in
one of three greens: strict reserve or wilderness (IUCN Ia/Ib), national park (II), or any other protection (monuments,
habitat areas, protected landscapes, nature reserves, state parks, protected forests). Zoomed in to a park you know, its
boundary sits where it belongs (to about 600 m, the finest tile's pixel). A WHAT LIVES HERE click lists the protected
areas at the point, most protective and smallest first: name, kind, designation and operator, and its OpenStreetMap id;
a point in none reads "no protected area mapped here". The legend says what the colours are, how many areas are too
small to show at about 600 m (a click still finds them; 51,866 of 174,337 in the first build), and that
OpenStreetMap's coverage is uneven and it is not an official registry. A fixed snapshot (its Overture release shown): not on the time
bar.

It is not WDPA: Protected Planet's licence forbids redistribution, and OSM is the only redistributable source found
(survey 2026-09-22). Where mappers have not drawn an area it is missing, and nothing here can tell that from no
protection.

## Source (probed 2026-10-03)

- Overture Maps base theme, `land_use`, `subtype = 'protected'` (release 2026-09-23.1, newest of
  `s3://overturemaps-us-west-2/release/`): 179,968 polygons and multipolygons, every one from OpenStreetMap
  (`sources[1].dataset`), licence `ODbL-1.0`; 27,024 unnamed; 980 MB of geometry unsimplified. Overture assembles OSM's
  multipolygon relations, which a planet extract would need osmium for (the planet file is 95 GB; 106 GB free).
- Classes and counts: nature_reserve 94,652 · species_management_area 27,640 · natural_monument 10,317 ·
  protected_landscape_seascape 9,912 · national_park 8,358 · wilderness_area 7,599 · environmental 7,413 ·
  aboriginal_land 5,631 · strict_nature_reserve 4,712 · protected 1,524 · forest 1,120 · state_park 1,090.
- DuckDB reads it over HTTPS with `enable_geoparquet_conversion = false` (geometry as WKB, no spatial extension); a
  bounding-box filter on the `bbox` column reads one park's neighbourhood in ~6 s, the whole subtype in ~6 min.
- Not the public Overpass API: its policy rules out "relying on the public instances as backend" for an app for more
  than mappers. Not a GeoJSON of entities: 180k polygons is ~200× the largest entity layer (ecoregions, 846).
- Licence: ODbL 1.0. Attribution "© OpenStreetMap contributors. Available under the Open Database License." (Overture
  attribution page). The tiles are a Produced Work (attribution); the lookup shards hold names and geometry, a
  Derivative Database, published under ODbL 1.0 with that notice. This is the site's only ODbL data file.

## Design

- **Classes** `pipeline/protected_areas.py` `CLASSES`: each of the 12 classes read and put in a group: strict
  (strict_nature_reserve, wilderness_area), national park (national_park), other (the rest), or left out
  (aboriginal_land: land tenure, not nature protection). A class not in the table, or a row whose source is not
  OpenStreetMap under ODbL-1.0, stops the run before anything is written.
- **Extract**: one DuckDB query copies the protected rows' id, name, class, `protection_title` and `operator` tags, OSM
  id (version suffix dropped) and Wikidata id with the WKB geometry into a local staging parquet named by the release, so
  a rerun of the same release reads nothing remote.
- **Geometry**: shapely, invalid ones repaired (`make_valid`, polygon parts kept), simplified at 0.001° (topology kept),
  a fifth of the finest pixel.
- **Tiles**: Cesium's geographic tiling scheme (as Human Footprint), finest level 7 (256 × 128 tiles of 256 px, 0.0055°,
  ~610 m). Each finest tile is rasterised from the areas whose bounds touch it, lower groups first so the most
  protective wins a shared pixel; coarser levels take the 2 × 2 maximum, so any protection painted at a fine level shows
  at every coarser one. Only tiles with a painted pixel are written; the manifest lists them and the layer serves a
  blank tile for the rest (no 404s). Palette PNG, transparent where unprotected.
- **Lookup shards**: per 1° cell (south-west corner, 90°N and 180°E folded in, as the OBIS grid), every area clipped to
  the cell: name, class, designation, operator, OSM id, Wikidata id, approximate area, polygons as rings of integers in
  1e-4° (~11 m), the first pair absolute and each later one the difference from the one before. Only cells holding an
  area are written and listed. (First full build, 5° cells of decimal coordinates: 132.5 MB, over the 100 MB budget, and
  7.8 MB for one click in the north-eastern US; the same build re-encoded measured 75.9 MB.)
- **Manifest** `protected_areas.json`, written last: release, date, maxLevel, tile template, palette, groups, class
  table, tile list per level, shard size, coordinate scale, shard template and list, counts (areas, per group, unnamed, left out, painting no pixel at
  level 7), source and licence.
- **Layer** `src/data/protectedAreas.js`, token `pa`, modelled on humanFootprint.js: a `UrlTemplateImageryProvider` whose
  `requestImage` serves a blank canvas for tiles not listed; one drape at a time; the readout fetches the point's shard
  (cached) and tests the point against each area's rings (even–odd, holes out).

Changed from the grill: a "card with links" is a WHAT LIVES HERE readout line (rows are text,
`src/bio/whatLivesHere.js` `layerRowText`), so the OSM id is named, not linked.

## Not in scope

WDPA or any comparison with it shipped; aboriginal_land; a time filter; marine protected areas OSM lacks; how well an
area is protected; a monthly cron (after the first real build is measured).

## Acceptance

- `pytest pipeline/tests/test_protected_areas.py`: class table (unknown class and non-OSM source refused, nothing
  written), extract on a parquet shaped like Overture's, rasterising planted polygons to exact pixels with the
  priority and the 2 × 2 maximum, empty tiles not written, shards clipped per cell with holes kept, manifest last.
- `node --test src/data/protectedAreas.test.mjs`: manifest validation, shard key folding, point in polygon with a hole,
  readout order and texts, blank tile for an unlisted tile without a request.
- Real execution: a bounding-box extract of Overture around Yellowstone through the pipeline; the full build on jobd.
- `node scripts/qa-protected-areas.mjs` (the acceptance check, local build then live): eight parks on six continents
  (Yellowstone, Banff, Manú, Serengeti, Kruger, Białowieża, Sagarmatha, Kakadu) each painted national-park green at an
  interior point and read by name; a point 0.02° either side of Yellowstone's west boundary (read from the served
  shard) painted inside and not outside; an unprotected point unpainted and read "no protected area mapped here"; one
  drape at a time; ignores the time bar; legend; no 404 or console errors.
