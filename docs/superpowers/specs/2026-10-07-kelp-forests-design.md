# Floating kelp forests (ever detected) — design

## Outcome

A layer **Floating kelp forests** (🌿, token `kp`): one drape giving, for each ~150 m cell, the share of it covered by
the authors' global floating kelp polygons, from pale yellow (a trace) through orange (half) to dark brown (all of it).
A WHAT LIVES HERE click reads "floating kelp: about N% of the ~150 m cell" ("under 1.5%" for the faintest colour) or
"no floating kelp mapped in this ~150 m cell". A fixed map (every detection 1984 onward), so not on the time bar.

## Acceptance check

```
~/miniconda3/bin/python3 -m pytest pipeline/tests/test_kelp.py -q                    # exit 0
node --test src/data/kelp.test.mjs                                                   # exit 0
npm test                                                                             # exit 0 (registry count base + 1)
~/miniconda3/bin/python3 -m pipeline.kelp                                            # writes public/data/kelp{,.json}
npm run build && node scripts/qa-kelp.mjs --url http://127.0.0.1:<port>/             # exit 0
```

`scripts/qa-kelp.mjs` reads its known answers from `scripts/qa_kelp_truth.py`, which never imports the pipeline.

## Source

- **File:** Arafeh-Dalmau N. et al., data record for "Intensifying marine heatwaves and limited protection threaten
  floating kelp forests globally", Zenodo 14816612 (concept 14736354, published 2025-02-05), CC BY 4.0:
  `Intensifying_MHWs_Protection_Global_Kelp.zip`, 309,596,717 bytes, Zenodo md5 2a0e3acf3e0a36e7d178de68176db508 (API
  read 2026-10-07). Only `Intensifying_MHWs_Protection_Global_Kelp/Data/Global_Floating_Kelp/Global_Kelp_Canopy_2-24.*`
  is used; the zip is read in place through GDAL's `/vsizip/`.
- **Paper:** Arafeh-Dalmau N., Villaseñor-Derbez J.C., Schoeman D.S., Mora-Soto A., Bell T.W. et al. (2025) Global
  floating kelp forests have limited protection despite intensifying marine heatwave threats. Nature Communications 16:3173,
  doi:10.1038/s41467-025-58054-4 (CrossRef read 2026-10-07: 17 authors, first Arafeh-Dalmau, published 2025-04-03;
  CC BY 4.0).
- **Shapefile:** 426,489 features, Polygon Z (Z dropped), fields OBJECTID and Country (13 values, including the
  misspelling "Canda" and both "United States" and "United States of America"), `.prj` GCS WGS 84 in degrees
  (EPSG:4326 per pyogrio, and the authors' `02_clean_kelp.R` sets EPSG:4326). Bounds 176.97°W–178.82°E,
  55.98°S–61.50°N. Polygon edges sit on a 2.69495e-4° (~30 m) grid except where the 30 m coastline buffer clipped
  them. 2,885 rings touch themselves (GEOS "Ring Self-intersection"; `make_valid` changes their area by 1e-17 deg²).
  Overlapping polygon pairs: 0 (checked: shapely STRtree `overlaps` query over all 426,489, 2026-10-07).
  The `.dbf` header's last update is 2024-02-16 (the file name's "2-24"), so detections run from 1984 to at most
  February 2024; the readout dates the map "ever detected, 1984 on (map of Feb 2024)".
- **What a polygon means** (paper, Methods): "Our final floating kelp habitat map includes any pixel the satellite
  detected kelp in the time series and represents the known presence of floating kelp habitat in the timeseries."
  Sources: Landsat, 30 m, 1984 onward, for most of the USA (California, Oregon, parts of Washington and Alaska), all of
  Mexico, Peru and Argentina, the Falklands and Tasmania; elsewhere a Sentinel-2 mosaic of 26 June 2015 – 23 June 2019
  (Mora-Soto et al. 2020) and a Sentinel-2 map of South Africa. Pixels within 30 m of the coastline were excluded. The
  authors say the map may underestimate Canada, Chile and New Zealand (the Sentinel-2 period is short). Floating-canopy
  species only (e.g. *Macrocystis pyrifera*, *Nereocystis luetkeana*, *Ecklonia maxima*): kelps without a surface
  canopy are outside this map.
- **Upstream licence:** the US and Mexico Landsat input is SBC LTER EDI package knb-lter-sbc.74.13, CC BY 4.0, with an
  ethical request to notify the data contact (EML read via the DataONE CN, 2026-10-07, by the coordinating session).
  The other regional inputs are co-authors' maps. This layer takes nothing from kelpwatch.org (its terms deferred by
  the user, 2026-09-12).
- **Placement:** polygon centroids lie within 5 km of the Natural Earth 10 m land boundary for 99.7% (Peru), 97.7%
  (Australia), 97.5% (Namibia), 97.3% (South Africa), 95.4% (Argentina), lower on fjord and island coasts (Chile 83.8%,
  Kerguelen 82.4%) where Natural Earth drops detail; shifting every polygon 0.2° east drops every country (Peru 0.997 →
  0.037). The coordinates are right as read.
- **Area:** the polygons' area on a sphere of radius 6,371.0088 km (Lambert cylindrical equal-area) is 2,216.18 km².
  The paper's Source Data (sheet "Figure 4, Figure S1, S4", `kelp_area_km2` summed over all rows) gives 2,216.55 km²;
  per country they agree to 0.4 km² (GBR 535.2 vs 535.6, USA 533.3 vs 533.4, Chile 449.6 vs 449.6). A global total in
  the paper's prose: none found (checked: regex over the Nature full-text HTML and the SI PDF for km², ha, hectares and
  "total", 2026-10-07).

## Pipeline (`pipeline/kelp.py`)

1. **Fetch:** the zip once into `$WILDEYE_CACHE/kelp` (default `~/.cache/wildeye/kelp`). A download whose md5 is not
   Zenodo's is refused and deleted; a cached file that no longer matches is refused with "delete it to fetch again".
2. **Read:** the shapefile through `/vsizip/`; refused unless EPSG:4326, Polygon geometries, and exactly 426,489
   features. Z is dropped.
3. **Count (the share method):** each level-9 cell of Cesium's geographic tiling scheme (1024 × 512 tiles of 256 px,
   0.001373°, ~150 m at the equator) is split into a subgrid of SUB × SUB = 64 × 64 subpixels (~2.4 m). Every polygon
   is burnt onto that subgrid by GDAL's rasterize (a subpixel counts when its centre is inside a polygon), block by
   block (32 × 32 cells; a polygon goes to every block its bounding box touches; each window cut to its polygons'
   extent). A cell's count is its kelp subpixels; its total is 4,096. Overlapping polygons would count once.
4. **Antimeridian:** a polygon's subpixel columns are worked out unwrapped (they may run past 180°E or 180°W), burnt in
   their own window, and the cells taken modulo 360°: a polygon across 180° splits between the world's last and first
   columns. A polygon whose bounding box is wider than 180° (one written the long way round) stops the run. This
   release's polygons stay inside 176.97°W–178.82°E (checked: pyogrio total_bounds, 2026-10-07); the nearest to 180°
   are in the Aleutians.
5. **Pyramid:** `pipeline/cell_share.py`'s `write_pyramid`, shared with the tidal marshes and seagrass: coarser levels
   add the counts of their four children, and each level's total is the subgrid's (SUB·2^(9−z))², so every level holds
   an exact share of subpixels. Whole percent, halves up; any kelp at all is at least 1; a count above the total stops
   the run.
6. **Write:** 8-bit palette PNGs (index = share, 0 transparent), painted tiles only, into a temporary directory. Over
   the byte budget (25,000,000 B) the run stops before `public/data/kelp/` is replaced or `kelp.json` written. Then the
   directory replaces `public/data/kelp/` and `kelp.json`, written last, lists the tiles per level with the palette,
   feature count, `kelpKm2` (polygons on the sphere), `drawnKm2` (counted subpixels on the sphere) and the source. If
   the two areas differ by more than 0.5% the run stops: a dropped block or a misplaced window shows there.

### Error bound

The drawn share differs from a cell's true share (polygon ∩ cell area over cell area) only through subpixels that a
polygon boundary crosses: |count/4096 − true| ≤ B/4096, where B is the number of the cell's subpixels a boundary
passes through (rigorous, but loose for cells with many 30 m pixel edges). Measured against exact shapely intersection
over 3,643 kelp cells in five regions (Monterey, southern Chile, Falklands, Tasmania, Cape Peninsula; 2026-10-07): mean
|error| 0.05–0.18 percentage points, 99th percentile ≤ 0.68 pp, maximum 1.04 pp; at 32 subpixels the maximum was
2.22 pp, at 16 it was 4.67 pp. With whole-percent rounding (0.5 pp) the stated bound is **|readout − true share| ≤
2 pp** (a readout of 1 means a share under 1.5%, so under 3.5% true); the QA also reports each cell's rigorous B.
The share is of the cell's area in degrees; over 0.00137° the difference from an equal-area share is below 1e-4 of the
share.

### Level and budget

Level 9 (~150 m), as the tidal marshes and seagrass: the drape and the readout share `geoTilePixel` and the listed-tile
provider. gh-pages is at 835 MB of 1 GB; this layer's budget is 25 MB.

**Real run (2026-10-07):** 426,489 polygons, 2,216.18 km² on the sphere, 2,216.2 km² drawn (counted subpixels);
21,441 blocks; 1,386 tiles at level 9 and 2,476 in all, 4,364,423 B (4.4 MB, 17% of the budget). 53 s on one core,
peak RSS 2.7 GB (`/usr/bin/time -v`). Level 9 fits with room; level 8 is not needed.

## Frontend (`src/data/kelp.js`)

- The tidal marsh layer's pattern: `listedTilesOnly` serves unlisted tiles blank without a request; the readout
  decodes the level-9 pixel through `geoTilePixel` and `createTilePixelReader`, a palette colour is its share,
  transparent is none, any other colour is an error row; an unlisted tile answers none without a read.
- The legend: five share bins in the colour of each bin's middle share, then the definition (ever-detected floating
  canopy; Landsat 1984 onward where it exists, Sentinel-2 2015–2019 elsewhere; underestimates Canada, Chile and New
  Zealand; floating-canopy species only), the mapped area and the paper's 2,216.6 km².
- The build time (`generated_at`) is a query string on tile URLs.
- Registered as `kelp`, token `kp` (checked: unused by all 65 tokens in `src/data/layerState.js`, 2026-10-07), on the
  drape list and in WHAT LIVES HERE; credit in `dataCredits.js` (paper, Zenodo record, SBC LTER as the US/Mexico
  input); a DATA_SOURCES row.

## Tests and QA

- `pipeline/tests/test_kelp.py`: synthetic polygons of known area in known cells (one cell, a cell edge, a tile edge,
  the antimeridian), coarser-level exactness against a brute count, the subgrid totals against `cell_share.Grid`,
  refusals (md5, feature count, a count over the total, the byte budget, a polygon the long way round, the area
  check), each with its positive control; one real-file check of the cached zip when present.
- `src/data/kelp.test.mjs`: manifest validation, decode, drape lifecycle, readout, legend, credit.
- `scripts/qa_kelp_truth.py`: exact share by a different method: shapely intersection of the `make_valid` polygons with
  each cell's box, both projected to a Lambert azimuthal equal-area CRS centred on the cell; plus the rigorous B.
  Cells: the densest and an edge cell (share nearest 50%) in California, southern Chile, Tasmania and South Africa, the
  kelp cell nearest 180°, a Falklands and a Peru cell, and two sea cells with no kelp (one beside kelp in a written
  tile, one in open ocean).
- `scripts/qa-kelp.mjs`: real browser against the built site; turns the layer on through the share token, reads every
  QA cell and compares with the truth within 2 pp; empty cells must read none; the positive control is the dense cells
  reading ≥ 50% in the same run.
- Mutants through `mutate-run` for the share, the cell indexing, the antimeridian, the coarsening and the budget.

**QA run (2026-10-07, built site on loopback):** 25/25 checks; the 13 cells read within 0.50 pp of the truth (rigorous
B 0–5.59 pp): Monterey 100 / 49.85 / 0, southern Chile 74.39 / 49.80, Tasmania 83.50 / 49.55, Cape Peninsula
100 / 50.05, Falklands 100, Peru 100, Antipodes Islands (178.81°E, nearest 180°) 12.42, open Pacific 0. The same run
with the readout moved one cell north fails 14 checks (mutate-run). A share link must carry lat and lon to restore
layers (`src/sharelink.js` `parseInitialHash`); the first QA run used a bare `#v=2&l=kp` and failed on it.

## Out of scope

- The MPA layer in the same zip (ProtectedSeas-derived) and any protection or heatwave result.
- Per-year dynamics (the polygons are a union over time).
- kelpwatch.org and its data.
- Kelp outside the authors' polygons (sub-canopy kelps).

## Constraints

- No other layer changes. `public/data/kelp/` and `kelp.json` are gitignored generated data (one-shot pipeline, no
  cron); not deployed by this change.
- Memory: polygons in memory; one block raster at a time (≤ 2048 × 2048 subpixels); 2.7 GB peak measured.
