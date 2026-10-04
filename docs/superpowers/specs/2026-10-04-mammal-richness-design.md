# Mammal richness from the MDD range maps — design

Wave 2, item 8 of 8 (ledger `grill_wildeye_wave2_2026-10-03.md`; decisions assumed, open to veto). Built on the
reptile richness layer's encoding (spec 2026-10-03-reptile-richness-design.md).

## Outcome

A layer **Mammal richness (MDD range maps)** (🐭, token `md`): how many wild mammal species' ranges overlap each 0.1°
cell, one colour per count from deep blue-violet (one) to pale yellow (the most). A WHAT LIVES HERE click reads "N mammal
species: R rodents, B bats, P primates, O other", or "No mapped mammal range". Not on the time bar.

It is not the existing **Mammal species (SEDAC, IUCN 2013)** layer (`gibs-mammals`), which is NASA's rendered image of
IUCN 2013 ranges and can be read only as colours. This one counts the 2022 harmonised maps of the current MDD taxonomy,
exactly per cell and by group.

## Source

- **Files:** Marsh, Sica, Burgin, Dorman et al., *Geographic range maps for Mammal Diversity Database v1.2 taxonomy*,
  Zenodo 6644198 (published 2022-03-27): `MDD_Mammalia.zip` (10.3 GB), which stores 27 order zips exported 2021-06-22
  (`MDD_<Order>.zip`, each holding `MDD_<Order>.gpkg` at the root or under `<Order>/`, plus `citation.txt`; one
  MultiPolygon per species, EPSG:4326, fields `sciname`, `order`, `family`, ...), and the list of the 6,362 species
  (`mdd_spList_wFamilieswOrders_mapped_6362species.csv`). Both md5s are pinned from the Zenodo API. The record's 27
  standalone order zips are an earlier export (2021-06-11) whose Sirenia holds the dugong only, without the three
  manatees, so they are not used.
- **Content:** 6,360 mapped wild extant species of MDD v1.2 (extinct and domestic species excluded). The list names
  6,362: the record's description says two of them (*Nycticeius aenobarbus*, *Phoniscus aerosus*) have no spatial
  information, and one civet's map spells its name *Paradoxurus philippinensis* where the list has *philippensis*.
  These are the only disagreements between the list and the maps (every name in the bundle checked 2026-10-04). The
  ranges carry no presence, origin or season codes.
- **Licence:** CC BY 4.0 (Zenodo record, read live 2026-10-04). The credit line says the polygons are counted per cell.
- **Cite:** Marsh, Sica, Burgin, Dorman et al. 2022, *Journal of Biogeography* 49:979–992, doi:10.1111/jbi.14330
  (CrossRef-checked 2026-10-04).

## Pipeline (`pipeline/mammals.py`)

1. **Fetch:** each file once into the cache, refused and deleted unless its md5 is Zenodo's.
2. **Layout:** the bundle must hold exactly 27 `MDD_<Order>.zip` (and `citation.txt`); each is copied out, read and
   deleted in turn. Each order zip must hold exactly one `MDD_<Order>.gpkg` for its own order (at the root or under `<Order>/`), and every feature's
   `order` must be that order. Each GeoPackage is extracted beside its zip with Info-ZIP `unzip`, read with pyogrio one
   feature at a time (a large whale's range is ~440 MB of WKB; 20 at once ran out of memory), and deleted: through GDAL's `/vsizip/` the same read is ~30× slower (Primates 71 s against 2 s),
   and Python's `zipfile` cannot inflate the Deflate64 that packs Chiroptera and Rodentia.
3. **Species:** the names read must be exactly the release list's, each once, under the order the list gives it, except
   the two pinned unmapped bats (a map for either stops the run) and the civet, counted under the list's spelling.
4. **Count:** each range is counted over its own bounding box on a global 0.1° grid in every cell it shares interior
   with (shapely: intersects and not touches): the cell's centre lies in the range (shapely, prepared) or the range's
   outline crosses the cell (rasterio `all_touched` on the outline as lines, on four grids moved 1e-7° diagonally,
   kept where all agree), so a range smaller than a cell still counts, and an outline running exactly along a grid line
   counts in neither cell beside it (burnt once, it counted in the cell east or south of it, and only when the range's
   bounds reached that cell: review of #56). GDAL's polygon fill walks every edge for every row, ~14 min for a whale
   range of 27 M vertices against ~31 s this way. Into rodents, bats, primates and other. An empty range, a range
   reaching past ±180° or ±90°, and any cell over 255 species stop the run.
5. **Tiles:** as for reptiles: the total by nearest neighbour to level 3 (4096 × 2048), one palette colour per count,
   coarser levels the mean over cells with any species; level-3 RGB group tiles hold rodents, bats and primates, so the
   readout splits the total exactly. Budget 6 MB.

**Real run (2026-10-04):** 6,360 species from the bundle in 31.5 min (1,892 s), up to 213 species in a cell, tiles
2.2 MB (display 1.47 MB, groups 0.69 MB) of the 6 MB budget. All 15 cells pre-registered from the raw polygons read
their counts exactly from the published tiles. Two findings from real data changed the build: the standalone order
zips lack the three manatees (so the bundle is read), and the list and the maps disagree in the three pinned names.

## Defects and limits

- **Expert ranges, not records.** A range is the extent of occurrence drawn by experts; a species need not be present
  in every cell of it.
- **The overlap rule counts edges.** A species counts in every cell its polygon reaches into, so totals near range
  edges run higher than a cell-centre rule would give.
- **255 per cell is the encoding's ceiling.** A run with more stops rather than clipping.

## Frontend (`src/data/mammals.js`)

- One geographic provider to level 3; the build time is a query string on tile URLs, drape and readout alike.
- The readout reads the pixel under the centre of the clicked point's 0.1° cell (level 3 carries 3600 cells on 4096
  pixels by nearest neighbour, so the pixel under an off-centre point can hold the next cell), and decodes the total from the display tile (the reptile layer's `decodeCount`) and the groups from the RGB
  tile at the same pixel; a group pixel that is not opaque or exceeds the total is an error row.
- The legend samples counts 1, 50, 100, 150, 200 and the maximum in their colours, then what is counted.

## Acceptance

- `pytest pipeline/tests/test_mammals.py`: synthetic release-shaped zips for the layout, list and encoding checks; a
  real-execution test that fetches three small orders and the species list from Zenodo through the pinned fetcher and
  compares 120 cells' counts with shapely intersections of the raw polygons; and, where the full release is cached,
  the published tiles at 15 cells (three of them manatee coasts) pre-registered from the raw polygons in the bundle
  with shapely before the layer was written.
- `node --test src/data/mammals.test.mjs`
- `node scripts/qa-mammals.mjs --url <dev server>` against the real build.
- Mutants via `mutate-run` for the pipeline, the module and the QA wiring.
- `npm run perf:load` EQUAL.

## Constraints

- No other layer changes; the reptile module's helpers are imported, not edited.
- `public/data/mammals/` and `mammals.json` are gitignored generated data, copied in before a deploy.
- CI's pipeline-tests job installs pyogrio and shapely; extraction needs Info-ZIP `unzip` on PATH (on GitHub's
  Ubuntu runners).
