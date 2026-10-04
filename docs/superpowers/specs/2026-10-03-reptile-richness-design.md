# Reptile species richness (GARD 1.7) — design (2026-10-03)

Wave 1 of the second global bio survey (`wildeye_bio_survey_2026-10-03.md`), the globe's first reptile layer. Decisions:
grill `grill_wildeye_wave1_2026-10-03` (delegated).

## Outcome

Switch on **Reptile richness (GARD 1.7)**. Land is shaded by how many reptile species' ranges overlap each 0.1° cell,
from 1 to 189 (Peninsular Malaysia), dark purple to pale yellow. A WHAT LIVES HERE click reads e.g. "189 reptile
species: 68 lizards, 102 snakes, 17 turtles, 2 other"; where no range reaches it reads "No mapped reptile range".
Static: no time bar.

## Source (read 2026-10-03)

- Zenodo 10.5281/zenodo.6499637, "GARD 1.7 - updated global distributions for all terrestrial reptiles", Roll and
  Meiri, 2022-04-27, licence CC0 (API). One shapefile, `Gard_1_7_ranges` (.shp 854,546,856 B; md5s pinned in the
  pipeline), one polygon per species: 10,914 species with `binomial`, `group` and `family`. Groups: lizard 6,658,
  snake 3,691, turtle 347, amphisbaenian 192, croc 25, Rhynchocephalia 1. The `.cpg` says UTF-8.
- The README asks users to cite Roll et al. 2017 (Nature Ecology & Evolution 1:1677, doi:10.1038/s41559-017-0332-2)
  and Caetano et al. 2022 (PLoS Biology 20(5), doi:10.1371/journal.pbio.3001544); both CrossRef-checked 2026-10-03.
- Checked on the raw shapes: 22 ranges have a bounding box wider than 180°; all are many-part island ranges (Pacific
  skinks and geckos, *Iguana iguana*), and their rasterised area is within 1–6% of GARD's own `area` field, so no ring
  wraps the globe.

## Design

- **Presence rule:** a species counts in every 0.1° cell its range overlaps (rasterio `all_touched`). With the
  cell-centre rule 1,712 species (16%) — the small-range ones — would fall in no cell at all.
- **Pipeline** `pipeline/reptiles.py`, run once: download the four shapefile parts from Zenodo into the cache
  (md5-pinned), rasterise every range into four counts per 0.1° cell (lizards, snakes, turtles, other =
  amphisbaenians, crocodilians and the tuatara), each range only over its own bounding box. An unknown group, a species
  count other than 10,914, or more than 255 in any count stops the run.
  - Display tiles: the total, resampled by nearest neighbour to 4096 × 2048 (level 3, so every 0.1° cell keeps its
    own pixels), one palette colour per count (0 transparent), coarser levels the mean over cells with any species.
    `pipeline/bii.py`'s nearest and `pipeline/hfp.py`'s tiling and PNG writing.
  - Group tiles: level 3 only, RGB = lizards, snakes, turtles; other = total − the three.
  - `public/data/reptiles/{z}/{x}/{y}.png`, `public/data/reptiles/groups/{x}/{y}.png`, then
    `public/data/reptiles.json` last. Budget 5 MB (the release makes 1.7 MB), else the run stops.
- **Layer** `src/data/reptiles.js`: the BII layer's drape (geographic tiling scheme to level 3, `geoTilePixel`); the
  readout decodes the level-3 display pixel (total) and group pixel exactly with the house PNG reader. Share token
  `rp`.

## Not in scope

Per-group maps or chips (one more pyramid each); species lists per cell; threat status (Caetano et al. 2022); marine
reptiles beyond GARD's terrestrial ranges.

## Acceptance

- `pytest pipeline/tests/test_reptiles.py`, `node --test src/data/reptiles.test.mjs` and `npm test` green; new tests
  seen to fail; mutants caught.
- Real file (pipeline test downloads it): 10,914 species, highest count 189. At the pre-registered cells the four counts
  equal the ranges whose raw shape intersects the cell (shapely, not the pipeline's code), fixed 2026-10-03:
  Malaysia 3.75, 101.75 → 68/102/17/2; Amazon −3.05, −60.05 → 47/113/13/7; inland Australia −25.05, 133.05 →
  82/22/0/0; Madagascar −18.95, 47.55 → 20/12/1/0; Texas 30.25, −97.75 → 17/37/15/1; Northland −35.45, 174.75 →
  7/0/0/1 (the tuatara); Sahara 23.05, 10.05 → 14/7/0/0; Greenland 72.05, −40.05, Antarctica −80.05, 0.05 and the
  mid-Pacific 0.05, −149.95 → 0. The points are cell centres.
- `node scripts/qa-reptiles.mjs --url <build>` in a real browser: the same readouts; one drape drawn when on and none
  before; legend and credit; share token; no 404 or console errors.
