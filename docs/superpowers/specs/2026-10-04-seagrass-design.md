# Seagrass 2019–2020 and 2023–2024 — design

Wave 2, item 7 of 8 (ledger `grill_wildeye_wave2_2026-10-03.md`; decisions assumed, open to veto). Stacked on the tidal
marshes (#54): both layers count shares through `pipeline/cell_share.py`.

## Outcome

A layer **Seagrass (2019–2020, 2023–2024)** (🌱, token `sg`): one drape giving, for each ~150 m cell, the share of it
that the 10 m map calls seagrass, from pale green (a trace) to deep green (all of it). The time bar picks the epoch: the
one whose first year is at or before the observed date, the latest when no date is set, and nothing before 2019. A
WHAT LIVES HERE click reads "seagrass: about N% of the ~150 m cell" ("under 1.5%" for the faintest colour), "no seagrass
mapped in this ~150 m cell", or "outside the map" north of 72.33°N and south of 51.29°S, dated by the epoch.

## Source

- **Files:** Peng, Li, Krause, Lyons, Murray, Schill, Roelfsema and Asner, *Global 10-meter seagrass maps*, Zenodo
  18612240 (published 2026-02-14): `GlobalSeagrass2019_2020.zip` (438,032,562 bytes, Zenodo md5
  2046bf6c62d85f4d57e678bf6ef1cd07) and `GlobalSeagrass2023_2024.zip` (448,760,997 bytes, md5
  d371628f0e343244eb47f188f0a89726). Both sha256s are pinned in `pipeline/seagrass.py`.
- **Content:** 299 and 301 GeoTIFFs on an Earth Engine export grid of 65,536-pixel tiles (1/11132° ≈ 10 m, uint8,
  1 = seagrass, 0 = not), EPSG:4326, 72.338°N to 51.293°S, the outermost columns reaching ±180.000015°. Tiles meet
  without overlap.
- **Licence:** CC BY 4.0 (Zenodo record, read live 2026-10-04). Credit and explain changes; the credit line says the
  10 m maps are drawn as cell shares.
- **Cite:** the Zenodo record, doi:10.5281/zenodo.18612240. No paper describing the maps was found (checked: OpenAlex
  search 2026-10-04, 22 hits from 2025 on, none these maps), so no accuracy figure is quoted.

## Pipeline (`pipeline/seagrass.py`, counting in `pipeline/cell_share.py`)

1. **Fetch:** each epoch's zip once into the cache, refused and deleted unless its sha256 is the pinned one.
2. **Layout:** a zip may hold only its folder and GeoTIFFs named for its own epoch. Each GeoTIFF must be one uint8
   band, EPSG:4326, the release's pixel size, north-up, within ±180.001° and 60°S–75°N, with no value above 1.
3. **Count, pyramid, share, write:** as for the tidal marshes (spec 2026-10-04-tidal-marshes-design.md), now shared in
   `cell_share.py`: each 10 m pixel goes by its centre to one level-9 cell; each cell keeps seagrass pixels (read) and
   all source pixels (worked out from the grids); coarser levels sum children and work totals out; whole percent,
   halves up, any seagrass at least 1. A cell with seagrass and no source pixel, or more seagrass than source pixels,
   stops the run.
4. **Manifest:** `seagrass.json` lists, per epoch, its key, label, first year, member count, mapped km², bytes and
   painted tiles per level; plus the palette and the source. Tiles live under `seagrass/<epoch>/`.

**Real run (2026-10-04):** 2019–2020: 299 GeoTIFFs, 148,605 km² of seagrass mapped, 5,993 tiles at level 9 and 11,499
in all, 30.3 MB. 2023–2024: 301 GeoTIFFs, 142,595 km², 6,016 tiles at level 9 and 11,531 in all, 31.0 MB. 61.3 MB in
all; 39 min on one core.

## Defects and limits

- **The epochs disagree cell by cell.** The two maps' seagrass pixels overlap with an IoU of 0.46–0.76 at four meadows
  (Shark Bay, Florida Bay, Moreton Bay, Banc d'Arguin), with the grids aligned (the best shift within ±10 px improves
  it by at most 0.007). A cell can read 100% in one epoch and 0% in the other. The legend says a difference is not on
  its own a change in the meadow.
- **Cells, not pixels.** A narrow meadow shows as a faint share of its ~150 m cell; Cesium upsamples level 9 further in.
- **Outside the map is not seagrass-free.** Beyond 72.33°N and 51.29°S the readout says "outside the map"; inside, a
  cell with no source GeoTIFF reads "no seagrass mapped", as does open land.

## Frontend (`src/data/seagrass.js`)

- One drape per shown epoch, through `listedTilesOnly` with that epoch's list; the share decode and legend bins are the
  tidal marsh layer's. `epochAt` (from the human footprint layer) picks the epoch; `getObservedExtent` spans 2019-01-01
  to 2024-12-31.
- Before 2019 the drape is hidden, the readout is a gap row and the stats carry "no seagrass mapped before 2019".
- The legend shows five share bins, then the definition, the shown epoch's mapped area and the caveat on comparing
  epochs. The build time is a query string on tile URLs.

## Acceptance

- `pytest pipeline/tests/test_seagrass.py pipeline/tests/test_tidal_marsh.py`: the seagrass fixtures are one zip per
  epoch in the release's own layout, holding verbatim windows of the real rasters at Card Sound, Florida, either side of
  the 25.24°N seam between two export tiles; counts are checked pixel by pixel with `np.add.at`, shares with `Fraction`.
- `node --test src/data/seagrass.test.mjs`
- `node scripts/qa-seagrass.mjs --url <dev server>` against the real build. The independent source is
  `scripts/qa_seagrass_truth.py`, which re-reads windows of both pinned zips with rasterio and counts each cell itself:
  six cells in each of six meadows, read at both epochs.
- Mutants via `mutate-run` for the pipeline, the module and the QA wiring.
- `npm run perf:load` EQUAL.

## Constraints

- The tidal marsh layer's output must not change: `cell_share.py` is its code moved, and its tests run unchanged.
- `public/data/seagrass/` and `seagrass.json` are gitignored generated data, copied in before a deploy.
- Pages budget: 61.3 MB for both epochs on a tree of 727.3 MB plus the open PRs' tiles (tidal marshes 20.8 MB,
  IFL 7.3 MB).
