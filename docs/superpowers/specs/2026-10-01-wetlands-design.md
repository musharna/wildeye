# Wetlands (GLWD v2) — design (2026-10-01)

Step 5c of the bio-interpolation wave (grill `grill_wildeye_bio_interpolation_2026-09-29`: Q8 Tier A one PR each;
Q14 and A1–A5 of step 5c, accepted `ok` 2026-10-01).

## Outcome

Switch on **Wetlands (GLWD v2)**. Cells that are mostly wetland are shaded by wetland type, 33 types in 8 colour
families (lakes, rivers and riverine, marshes and swamps, peat, coast, salt pans, ephemeral, rice paddies), at about
1.2 km. A WHAT LIVES HERE click names the type in GLWD's own words ("Temperate peatland, non-forested"); mostly dry
land reads "Mostly dryland"; the sea and anything outside 56°S–84°N read "no data". A fixed map: not on the time bar.

## Source (probed 2026-10-01)

- figshare 28519994 v1 (2025-05-23), CC BY 4.0; the authors ask that the data not be redistributed in whole in its
  original format, so only rendered display tiles are published. `GLWD_v2_0_combined_classes_tif.zip` (925 MB, md5
  pinned; a file whose md5 differs, cached or fetched, is refused) holds `GLWD_v2_0_main_class_50pct.tif`: uint8,
  86,400 × 33,600, EPSG:4326, 180°W–180°E × 56°S–84°N (15″, ~500 m), 255 = no data (sea), 0 = dryland or wetland
  ≤ 50% of the cell, 1–33 = the dominant wetland class where wetland is > 50%; `GLWD_Legend_v2_0.csv` names them.
- It marks ~11% of land at ~1.2 km (12.6% at full resolution; the paper's total wetland area is 13.4%). The
  any-wetland grid (`main_class`) marks 39% and was rejected as overstating (Q14).
- Cite Lehner, Anand, Fluet-Chouinard, Tan et al. 2025, Earth System Science Data 17:2277–2329,
  doi:10.5194/essd-17-2277-2025 (CrossRef-checked), and link https://www.hydrosheds.org/products/glwd as asked.

## Design

- **Pipeline** `pipeline/glwd.py`, run once: read the full 500 m grid; for each level 6…0 of Cesium's geographic
  tiling scheme warp it straight from the source by mode, sea excluded (a coastal pixel takes the majority of its land
  cells, so coastal mangroves survive). Tile palette index = class id (0 dryland, 1–33), 34 = no data; dryland
  (0,0,0) and no data (255,255,255) both transparent, told apart by colour. Every tile is written, empty ones too, to
  `public/data/glwd/{z}/{x}/{y}.png`, then `public/data/glwd.json` with the classes (id, name verbatim from the legend
  CSV, colour, family), the families, the tile template and the source. ~24 MB.
- **Layer** `src/data/wetlands.js`: a drape (exclusive, in compare) on the geographic tiling scheme, maximum level 6,
  driven by `glwd.json`. Readout: the level-6 tile pixel through the exact PNG reader, looked up in the manifest;
  an unknown colour is named. Share token `wl`.

## Not in scope

Wetland share (`area_pct`), the any-wetland grid, the 33 per-class extent grids, re-hosting any GLWD file.

## Acceptance

- `pytest pipeline/tests/test_glwd.py` and `npm test` green; new tests seen to fail first; mutants caught.
- A real pipeline run (jobd) writes every tile of levels 0–6; its size is reported.
- `node scripts/qa-wetlands.mjs` against a local build exits 0: the layer draws; readouts at Lake Victoria (a lake
  class), the Sundarbans (mangrove), the Hudson Bay Lowlands (a peatland class) and the Sahara (dryland) match an
  independent read of the 500 m source; the open sea reads no data; every pixel of the tiles read decodes; no 404s; no
  page errors.
- Perf gates equal, or a measured, explained acceptance.
