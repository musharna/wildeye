# Modelled soil bacterial richness (Bickel et al. 2026) — design (2026-10-07)

The globe's first soil microbe layer, built on the reptile richness route (same 0.1° grid, level-3 drape and readout).

## Outcome

Switch on **Soil bacterial richness (model)**, share token `sb`. Land the model covers is shaded by modelled bacterial
richness per soil sample, from ~180 (orange-brown) to ~900 (pale yellow), in 0.1° cells. A WHAT LIVES HERE click reads
"≈734 bacterial sequence variants per soil sample (model spread ±190)" for the cell holding the point; where the model
has no value (sea, Antarctica, the cells it leaves blank) it reads "No modelled soil estimate". The legend states the
unit and that this is a model: R² 0.41 from 320 sampled locations, richness of one sample at 7,500 reads, source and
licence. Static: no time bar.

## Acceptance check

```
python3 -m pytest pipeline/tests/test_soil_bacteria.py -q        # includes the real release
node --test src/data/soilBacteria.test.mjs src/data/layerState.test.mjs
npm test
python3 -m pipeline.soil_bacteria                                  # public/data, ≤ 5,000,000 B
python3 -I scripts/qa_soil_bacteria_truth.py ~/.cache/wildeye/soil_richness/ensemble.zip > /tmp/soil_truth.json
npm run build && (serve dist on a loopback port) && node scripts/qa-soil-bacteria.mjs --truth /tmp/soil_truth.json --url http://127.0.0.1:<port>/
```

Each exits 0. The pipeline tests and the QA script were each seen to fail on a broken state for the stated reason, and
mutants of the encoding, placement, budget and NaN handling are killed (`mutate-run`).

## Source (read 2026-10-07)

- Zenodo record 21133869, "Global maps of soil microbial and plant richness", Bickel S., 2026-07-02, licence
  `cc-by-4.0` (API `metadata.license.id`). File `ensemble.zip` (69,130,493 B, md5 `822beb1e913521d4831b4d12320f4278`),
  fetched once from `https://zenodo.org/api/records/21133869/files/ensemble.zip/content` and refused unless the md5
  matches. Only `bacteria_mean.nc` and `bacteria_std.nc` are read; fungi (held-out R² 0.13) and plants are not shipped.
- Each file (netCDF-4): `richness(lat, lon)`, float64, 1800 × 3600; `lat` 89.95 → −89.95 and `lon` −179.95 → 179.95 by
  0.1°, so cell edges are exactly ±180°/±90°. 76.5% NaN, the same cells in both files. Mean 183.0–895.2, SD 63.0–268.9.
- **Stale GeoTransform.** `spatial_ref` carries `GeoTransform = "-180.0 0.0099999984 0.0 83.999167206 0.0
  -0.0099999984"` (a 0.01° grid topped at 84° N), which contradicts the axes. The axes are the authority: the non-NaN
  mask agrees with Natural Earth 10 m land on 99.28% of cells 80° N–60° S with no shift, against ≤ 98.99% for any
  ±1-cell shift (coastal cells 0.822 vs ≤ 0.709; checked by the coordinator 2026-10-07). The pipeline reads the `lat`
  and `lon` variables, refuses any grid that is not this regular global 0.1° one (every coordinate of both axes checked,
  north first, west first), and never reads the attribute; a test plants a different GeoTransform and expects identical
  output.
- **What the number is.** Bacterial 16S rRNA sequence variants (Deblur) found in 7,500 sequencing reads of one soil
  sample, averaged over 100 rarefactions: the training data of Bickel et al. 2019 (Zenodo 3366252,
  `scripts/bash/filter_biom.sh` line 19 `-n 7500`; `scripts/r/preprocess_biom.R` lines 57–63, `rarefaction <- 7500`,
  `nsim=100`; both read 2026-10-07). It is **modelled**: Bickel S., Abdelfattah A., Tack A.J.M., Wicaksono W.A.,
  Berg G. (2026) Associations among soil microbial and plant richness across global terrestrial biomes. ISME
  Communications 6, ycag266, doi:10.1093/ismeco/ycag266 (CrossRef 2026-10-07: first author Bickel Samuel, 2026, CC BY
  4.0). Stacked random forest + XGBoost on ten environmental variables (WorldClim, MSWEP, GOSIF, SoilGrids…), 0.1°.
  Held-out R² for bacteria 41 ± 9% (max 62%), n = 320 sample locations (paper, Results; read in the PMC full text
  2026-10-07). The `_std` file is the spread of the model ensemble; the paper's model uncertainty "highlights
  undersampled regions (e.g. Sahara)". It is not a confidence interval and the layer does not call it one.
- **Ice sheets.** The model has values over Greenland's ice sheet (19,956 of the 20,000 cells in 68–78° N, 50–30° W;
  312–535; e.g. ≈324 at 72.05° N, 40.05° W), where no soil was sampled: model extrapolation with no soil samples behind
  it. Antarctica is blank (no cell south of 60° S has a value; read from bacteria_mean.nc 2026-10-07). The data are
  drawn as published, not masked; the legend says so.

## Design

- **Pipeline** `pipeline/soil_bacteria.py`, run once (`python3 -m pipeline.soil_bacteria`, `--cache` default
  `$WILDEYE_CACHE` or `~/.cache/wildeye`, files under `soil_richness/`). The two members are read from the zip into
  memory (netCDF4 `memory=`), never extracted. Checks that stop the run: md5; variable or dims not `richness(lat, lon)`;
  either axis off the grid; a value that is ±inf, ≤ 0, or (rounded) over 4095; SD < 0; the two files' NaN cells differ;
  a mean outside the display range 150–900; tiles over the budget.
- **Rounding.** Mean and SD are rounded to whole numbers half up (`floor(x + 0.5)`) on the 0.1° grid before anything
  else; the readout shows those integers.
- **Readout tiles (the encoding).** Level 3 only, `soil_bacteria/value/{x}/{y}.png`, 8-bit RGBA, the 0.1° grid
  resampled by nearest neighbour to 4096 × 2048 (each pixel takes the cell under its centre). For a cell with data:
  R = mean mod 256, G = SD mod 256, B = ⌊mean / 256⌋ + 16 · ⌊SD / 256⌋, A = 255; so mean = R + 256 · (B mod 16) and
  SD = G + 256 · ⌊B / 16⌋, each 0–4095. SD reaches 269 > 255, which is why a single byte will not do. No data:
  0, 0, 0, 0. The layer refuses any alpha but 0 or 255, and a no-data pixel that is not all zero. The low bytes carry the
  smooth part of the field and the high nibbles barely change, which PNG's row filters compress best (measured on the
  release: 3.19 MB, against 3.31 MB for 12 + 12 bits packed across R, G, B).
- **Display tiles.** `soil_bacteria/{z}/{x}/{y}.png`, levels 0–3, 8-bit palette PNG. Level 3 is the rounded mean
  resampled by nearest neighbour to 4096 × 2048 (every 0.1° cell keeps its own pixels); each coarser level is the mean
  of the 2 × 2 block's pixels that have data (pipeline/hfp.py's `block_mean`). Values are put in 75 bins of 10 from 150
  to 900 (index 1 = [150, 160) … index 75 = [890, 900]); index 0 is transparent. Bins of 10 rather than 5 save 0.36 MB
  of tiles for a step of 1.3% of the range that the eye cannot separate; the readout carries the exact number.
- **Ramp.** ColorBrewer YlOrBr, from its fourth-darkest stop (204, 76, 2) to its palest (255, 255, 229): low richness
  orange-brown, high pale yellow, luminance rising, so more reads lighter on the dark globe as the reptile and mammal
  layers do. The two darkest browns are dropped (lost on the night globe, as reptiles dropped inferno's black start);
  brown-to-yellow reads as soil and differs at a glance from the reptile (inferno) and mammal ramps. Every bin a distinct
  colour.
- **Budget** 5,000,000 B for display + readout tiles (the release, measured in prototype: ~1.38 MB + ~3.19 MB); over it
  the run stops before publishing. Tiles are staged and swapped in whole; `soil_bacteria.json`, written last, is what
  the layer reads (tile templates, maxLevel 3, palette, display bins, encoding, value ranges, model R² and n, source).
- **Layer** `src/data/soilBacteria.js`: the mammal layer's drape (geographic tiling scheme to level 3, build-time cache
  bust); the readout reads the value-tile pixel under the centre of the clicked point's 0.1° cell (`cellCentre`, as
  mammals: level 3 carries 3600 cells on 4096 px) with the house PNG reader, and decodes it exactly. Legend: 200, 400,
  600, 800 in their bin colours, plus the caption. Credit entry with the dataset, the paper, CC BY 4.0 and what was
  changed. DATA_SOURCES row. Token `sb`.

## QA (independent truth)

`scripts/qa_soil_bacteria_truth.py` opens the two members with xarray (not netCDF4 index arithmetic) and, for 14
points, reads mean and SD with `.sel(lat, lon, method="nearest")` at the point itself, which lies 0.04° from its cell
centre toward the sea for coastal cells. Points: coastal cells found by walking in from the sea on every side of Africa
(west, east, north, south) and of Australia (north, south), Chile (west coast, southern hemisphere), both sides of the
antimeridian in Chukotka (179.95° E and 179.95° W) and Fiji (16.85° S), the Amazon, the Sahara, plus two ocean points
(mid-Pacific, South Atlantic) that must read no value. Each of the 13 land cells is read again at its four corners,
0.045° in from both edges (65 land points in all), where the level-3 pixel under the point is often the next cell's,
so the readout's snap to the clicked cell is what makes them pass; their control is the cell diagonally across the
corner. `scripts/qa-soil-bacteria.mjs` loads the built site, turns the
layer on through its share token, reads each point through the site's readout and compares the text with the truth
(whole numbers, half up); ocean points must read "No modelled soil estimate". Positive control in the same run: the
truth with mean and SD swapped, and the neighbouring cell's truth, must not match what the site shows.

## Out of scope

Fungi and plant richness (in the same zip; fungi R² 0.13). Any colouring of the SD (readout only). Per-biome summaries,
time variation, or the paper's richness correlations. The record's `richness.zip` and overlay PNG.
