# Freshwater fish per drainage basin (Tedesco et al. 2017, updated to 2024) — design (2026-10-03)

Wave 1 of the second global bio survey (`wildeye_bio_survey_2026-10-03.md`), the globe's first freshwater-biodiversity
layer. Decisions: grill `grill_wildeye_wave1_2026-10-03` (delegated).

## Outcome

Switch on **Freshwater fish (drainage basins)**. 3,364 river and lake basins are filled by how many freshwater fish
species live in them, from 1 to 2,815 (the Amazon), on 8 log-spaced colour bins; chips toggle the 7 biogeographic realms.
A WHAT LIVES HERE click inside a basin reads e.g. "Amazon · 2,815 freshwater fish species"; where the source's basins
overlap, every basin under the point is listed; outside every basin it reads "Not in a mapped drainage basin". Clicking a
basin opens an info box with its realm, country, species count, its five largest families and its area. Static: no time
bar.

## Source (read 2026-10-03)

- Zenodo 10.5281/zenodo.19511163, "A global geospatial dataset of freshwater fish species at the drainage-basin scale
  (updated to December 2024)", Liuyong Ding, licence CC BY 4.0 (API). It updates Tedesco et al. 2017 (Scientific Data
  4:170141, doi:10.1038/sdata.2017.141, CrossRef-checked 2026-10-03); the record asks users to cite both.
- `Basin_202412_3364.shp/.dbf/.shx` (49,309,312 / 1,631,798 / 27,012 B; md5s pinned in the pipeline): WGS 84 polygons,
  fields `basin_d`, `basin`, `bggrph_` (realm), `country`, `n_specs`, `cntr_ln`, `cntr_lt`. The dbf is Latin-1
  ("México"). 3.07 M vertices, all valid.
- `cas_freshwater_202412.xlsx` (7,304,707 B): one row per species with `valid_name`, `class`, `order`, `family` and
  `basin` (`;`-separated). For all 3,364 basins, `n_specs` equals the number of distinct `valid_name`s listing it
  (18,821 species, as the record says; 4 rows have no name). There is no native/introduced status. Its `cas_info` and `references` columns
  are Catalogue of Fishes text and are never published.
- Checked on the raw shapes: Amazon (−60, −3) reads Amazon 2,815; Congo (20, −1) 1,232; Mississippi (−90, 35) 490;
  Thames (−1, 51.6) 31; the Atlantic, Greenland's ice sheet, Antarctica and inland Australia (133, −25) read no basin.
  Basins overlap: 30 pairs by more than 0.01 deg², some wholly inside another (Mabelle River in Komo River, Sale River in
  Charnley, Narathiwat in Golok), so a point can be in two basins.

## Design

- **Pipeline** `pipeline/freshwater_fish.py`, run once: download the four files from Zenodo into the cache (md5-pinned,
  as `marine_realms.fetch`), read the shapefile with pyshp (Latin-1) and the species table with openpyxl, stop unless
  every basin's `n_specs` equals its distinct species in the table and no species has two rows, keep each basin's five largest families, simplify
  with `ecoregions.simplify_geometry` (0.05°, as realms), cut parts wider than 90° (`marine_realms.split_wide`), area
  from the unsimplified shape, colour by log bin, write `public/data/freshwater_fish.geojson`. Exactly 3,364 basins,
  unique ids, or the run stops; over 6 MB or the run stops.
- **Layer** `src/data/freshwaterFish.js`: `marineRealms.js`'s polygon pattern with the 7 realms as chips, legend =
  the 8 bins, `readoutAt` listing every basin whose shape holds the point. Share token `ff`. The info box reaches the
  screen through the details card (`BIO_CARD_LAYER_IDS`).

## Not in scope

Per-basin species lists (the table is 99,432 basin-species rows); native/introduced status (not in the source);
the Tedesco 2017 release itself.

## Acceptance

- `pytest pipeline/tests/test_freshwater_fish.py`, `node --test src/data/freshwaterFish.test.mjs` and `npm test`
  green; new tests seen to fail; mutants caught.
- Real file: 3,364 basins, every part valid, no part wider than 90°, ≤ 6 MB; at the pre-registered points the set of
  basins read on the simplified output equals the set read on the raw shapes; the empty points read none.
- `node scripts/qa-freshwater-fish.mjs --url <build>` in a real browser: readout at the pre-registered points, both
  basins at an overlap point, nothing in the ocean; realm chips hide and show; info box; legend and credit; share
  token; no console errors.
