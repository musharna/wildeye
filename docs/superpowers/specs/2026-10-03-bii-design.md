# Biodiversity Intactness Index (NHM) — design (2026-10-03)

Survey Tier B (`wildeye_global_bio_coverage_survey_2026-09-22.md`). Decisions: grill `grill_wildeye_bii_2026-10-03`
(delegated by the maintainer, "defer grilling session to you"; build on "build").

## Outcome

Switch on **Biodiversity intactness (NHM, 2000–2020)**. Land is shaded by the Biodiversity Intactness Index, pale (0%,
completely degraded) to deep green (100%, intact), at about 5 km. Scrubbing the time bar shows the latest of five
snapshots at or before the date shown (2000, 2005, 2010, 2015, 2020). A WHAT LIVES HERE click reads "BII 64–65% ·
2020"; the sea and anything without data read "no data". The legend says what the index is: modelled share of the
original species abundance remaining, NHM v2.1.1, ~10 km.

## Source (read 2026-10-03)

- NHM Data Portal, "The Biodiversity Intactness Index developed by The Natural History Museum, London, v2.1.1 (Open
  Access, Limited Release)", doi:10.5519/k33reyb6: one zip, 45,890,222 B, sha256
  4bcc68c57396a0e82670f5319fcaeb747d7a52f9d91b21d36ae6a88d099178d1. Five GeoTIFFs `bii-<year>_v2-1-1.tif`, EPSG:4326,
  5 arc-minutes (4320 × 2160), float64, NaN = no data, values 0–100 (min 0.42, max 99.96 seen). README: "temporally
  limited" = these five years (the annual series is by request).
- Licence CC BY-NC-SA 4.0 (README, LICENSE.txt is the unmodified CC text; CKAN `other-nc`). © The Trustees of the
  Natural History Museum, London. Published here under the repo's free, non-commercial release policy, as SEDAC
  richness (accepted 2026-10-02); the tiles and manifest are adaptations and carry the same licence.
- The file server answers scripts with a Cloudflare challenge (HTTP 403, `cf-mitigated: challenge`); the catalogue API
  does not. The zip is downloaded once by a person in a browser (which is also where its terms are accepted) and the
  pipeline reads it from the cache, refusing any file whose sha256 differs. v2.1.1 is a fixed release.
- Cite: De Palma, Contu, Thomas, Duffin, Nix, Purvis (2024). The Biodiversity Intactness Index developed by The Natural
  History Museum, London, v2.1.1 (Open Access, Limited Release) [Data set]. Natural History Museum.
  https://doi.org/10.5519/k33reyb6 (the README's suggested citation).

## Design

- **Pipeline** `pipeline/bii.py`, run once: per year, resample to lon/lat 8192 × 4096 (~4.9 km) by nearest neighbour,
  so each level-4 pixel carries one source pixel's value exactly (the source is coarser than the tile grid); average
  down 2 × 2 for levels 3–0. Quantise to 100 bins, [k, k+1) for k = 0–98 and [99, 100], one distinct palette colour
  each, no data transparent; a value outside 0–100 stops the run. Write every tile of levels 0–4 to
  `public/data/bii/<year>/{z}/{x}/{y}.png` and `public/data/bii.json` last (years, tile template, palette, bins,
  source). Tiling, block mean and PNG writing are `pipeline/hfp.py`'s. Budget: 40 MB for all five years, else the
  run stops.
- **Layer** `src/data/bii.js`: the Human Footprint layer's pattern (`src/data/humanFootprint.js`: `geoTilePixel`,
  `epochAt` reused), a drape on the geographic tiling scheme to level 4, on the time bar 2000–2020; readout decodes the
  level-4 pixel through the exact PNG reader and names an unknown colour. Share token `bi`.
- This replaces the grill's 5° JSON shards: the tile pixel is already exact (the house PNG reader decodes the bytes,
  not a canvas), so shards would only duplicate it.

## Not in scope

The annual or finer NHM series (by request), Impact Observatory 100 m BII (CC BY, 2017–2020; a later "detail" option),
SSP projections and country summaries (`bii-bte`, a different model), marine intactness.

## Acceptance

- `pytest pipeline/tests/test_bii.py`, `node --test src/data/bii.test.mjs` and `npm test` green; new tests seen to
  fail; mutants caught.
- Real file: every level-4 pixel of every year decodes to floor(source value) at that pixel's centre (checked over the
  whole raster in the pipeline test against the real zip when present).
- `node scripts/qa-bii.mjs --url <build>` in a real browser: readout at pre-registered points equals the bin of the raw
  raster (central Amazon −3.5417, −62.4583; boreal Siberia 61.9583, 105.0417; Iowa 41.9583, −93.4583; Paris 48.875,
  2.375); contrasts hold (Amazon and Siberia > Iowa > Paris); Rondônia −10.0417, −63.0417 reads lower in 2020 than 2000
  (40.72 → 39.82 in the source); mid-Pacific 0.0417, −149.9583 reads no data; one drape; the time bar switches
  snapshot; legend and credit; no 404 or console errors. The points are cell centres: on a multiple of 1/12° the
  release's float-noise transform and plain index arithmetic pick different cells.
- The frontier, on the source (pipeline test): the mean over Rondônia (13.7–7.9° S, 66.8–59.8° W) falls at every
  snapshot (80.8 → 74.6); one cell is too noisy to carry that (a neighbour of the QA cell rises 29.7 → 32.7).
