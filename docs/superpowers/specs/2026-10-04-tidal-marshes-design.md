# Tidal marshes 2020 — design

Wave 2, item 6 of 8 (ledger `grill_wildeye_wave2_2026-10-03.md`; decisions assumed, open to veto).

## Outcome

A layer **Tidal marshes 2020** (🌾, token `tm`): one drape giving, for each ~150 m cell, the share of it that the 10 m
map calls tidal marsh, from light green (a trace) through blue (half) to deep blue (all of it). A WHAT LIVES HERE click
reads "tidal marsh: about N% of the ~150 m cell" ("under 1.5%" for the faintest colour), "no tidal marsh mapped in this
~150 m cell", or "outside the map" north of 60°N and south of 60°S, where the map stops. One year, so not on the time
bar.

## Source

- **File:** Worthington, Spalding, Landis, Maxwell, Navarro, Smart and Murray, *Global tidal marshes 2020*, v2.6,
  Zenodo 8420753 (published 2023-10-09): `tidal_marsh_v2_6.zip`, 201,567,459 bytes, Zenodo md5
  1bab179f7506b3525d2e9a2c28e27001. The sha256 is pinned in `pipeline/tidal_marsh.py`.
- **Content:** 154 GeoTIFFs `Final_Rasters/tidal_marsh_<lon>_<lat>_v2_6.tif`, each a 10° tile named by its south-west
  corner (111,320 px square, 1/11132° ≈ 10 m, uint8, 1 = tidal marsh, 0 = not), EPSG:4326, 60°N to 60°S. Neighbouring
  tiles overlap by up to one pixel column or row.
- **Licence:** CC BY 4.0 (Zenodo record, read live 2026-10-04). Credit and explain changes; the credit line says the
  10 m map is drawn as cell shares.
- **Cite:** Worthington et al. 2024, Global Ecology and Biogeography 33:e13852, doi:10.1111/geb.13852 (OpenAlex record
  checked 2026-10-04). The paper's area estimate for 2020 is 52,880 km² (95% CI 32,030–59,780), from a map with overall
  accuracy 0.85.

## Pipeline (`pipeline/tidal_marsh.py`)

1. **Fetch:** the zip once into the cache. A download whose sha256 is not the pinned one is refused and deleted. A
   cached file that no longer matches is refused with "delete it to fetch again".
2. **Layout:** the zip may hold only `Final_Rasters/` and GeoTIFFs matching the release's names. Each GeoTIFF must be
   one uint8 band, EPSG:4326, the release's pixel size, north-up, inside 60°N–60°S, with no value above 1. The zip is
   read in place through GDAL's `/vsizip/`, in row bands.
3. **Count:** every 10 m pixel goes, by its centre, to one pixel of Cesium's geographic tiling scheme at level 9
   (1024 × 512 tiles, 0.00137°, ~150 m at the equator). Each cell keeps two counts: its marsh pixels (summed from the
   rasters) and all its source pixels (worked out from each GeoTIFF's grid, not read). An overlap pixel adds to both
   counts alike, so a cell on a seam is still a true share. Longitude is taken modulo 360: the two 180W GeoTIFFs
   (Adak Island, Tonga) are georeferenced at 180–190°E, so each splits into a first column at the east edge of the world
   and the rest at its west edge. The first real run missed this and listed tiles off the grid (found before the PR;
   LESSONS.md).
4. **Pyramid:** coarser levels add the marsh counts of their four children and work their totals out the same way, so
   every level holds an exact share, not an average of rounded shares.
5. **Share:** whole percent, halves up, in integers; any marsh at all is at least 1. A cell with marsh and no source
   pixel stops the run.
6. **Write:** 8-bit palette PNGs (index = share, 0 transparent), painted tiles only, listed per level in
   `tidal_marsh.json` with the palette, year, version, member count, mapped marsh km² (each 10 m pixel's area on the
   sphere) and the source.

**Real run (2026-10-04):** 154 GeoTIFFs, 52,822.8 km² of marsh mapped; 5,651 tiles at level 9 and 11,253 in all, 20.8 MB
(the Pages tree was 727.3 MB of 1 GB before this). 45 min on one core.

## Defects and limits

- **Mapped area and the paper's figure differ by 0.1%.** The pixel count gives 52,823 km²; the paper gives 52,880 km²
  (95% CI 32,030–59,780). The difference is not traced; the legend gives both.
- **Cells, not pixels.** A 10 m marsh fringe shows as a faint share of its ~150 m cell; the drape cannot show the
  marsh's own shape. Cesium upsamples level 9 when zoomed further in.
- **The map stops at 60°.** North of 60°N and south of 60°S is unmapped, not marsh-free; the readout says "outside
  the map" there.

## Frontend (`src/data/tidalMarsh.js`)

- `listedTilesOnly` from the protected-areas layer serves unlisted tiles as blank, with no request.
- The readout decodes the level-9 pixel through `geoTilePixel` and `createTilePixelReader`: a palette colour is its
  share, transparent is none, any other colour is an error row. An unlisted tile answers none without a read.
- The legend shows five share bins in the colour of each bin's middle share, then the definition, the mapped area and
  the paper's estimate.
- The build time (`generated_at`) is a query string on tile URLs, for both the drape and the readout.

## Acceptance

- `pytest pipeline/tests/test_tidal_marsh.py` runs on a fixture zip of the release's own layout holding two verbatim
  windows of the real rasters at The Wash, either side of the 0° seam. Expected counts are made pixel by pixel with
  `np.add.at`, and expected shares with `Fraction`.
- `node --test src/data/tidalMarsh.test.mjs`
- `node scripts/qa-tidal-marsh.mjs --url <dev server>` against the real build. The independent source is
  `scripts/qa_tidal_marsh_truth.py`, which re-reads windows of the pinned zip with rasterio and counts each cell's
  pixels itself: six cells in each of six estuaries.
- Mutants via `mutate-run` for the pipeline, the module and the QA wiring.
- `npm run perf:load` EQUAL.

## Constraints

- No other layer changes.
- `public/data/tidal_marsh/` and `tidal_marsh.json` are gitignored generated data, copied in before a deploy (one-shot
  pipeline, no cron).
- Tiles must fit the Pages budget: the gh-pages tree is 727.3 MB of 1 GB.
