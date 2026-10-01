# Human Footprint — design (2026-10-01)

Step 5b of the bio-interpolation wave (grill `grill_wildeye_bio_interpolation_2026-09-29`: Q8 Tier A one PR each;
Q13 and A1–A5 of step 5b, accepted `ok` 2026-10-01).

## Outcome

Switch on **Human footprint (Mu et al., 2000–2024)**. Land is shaded by human pressure, pale yellow (0, wild) to dark
red (50, cities), at about 5 km. Scrubbing the time bar shows the latest of five snapshots at or before the date shown
(2000, 2006, 2012, 2018, 2024). A WHAT LIVES HERE click reads "Human footprint 12–13 of 50 · 2018"; the sea and
anything without data read "no data".

## Source (probed 2026-10-01)

- figshare 16571064 v8 (2025-11-05), CC BY 4.0, one zip per year holding one float32 GeoTIFF: Mollweide (ESRI:54009),
  1 km, 36,081 × 16,382, NaN for no data, values 0–50. figshare's md5 of each zip is pinned; a file whose md5 differs,
  cached or fetched, is refused.
- Cite Mu, Li, Wen, Huang et al. 2022, Scientific Data 9:176, doi:10.1038/s41597-022-01284-8 (CrossRef-checked).

## Design

- **Pipeline** `pipeline/hfp.py`, run once (a static release): per epoch, reproject to lon/lat by area average at
  8192 × 4096 (~4.9 km), then average down to 4096, 2048, 1024 and 512 for the coarser levels. Quantise each level
  to 50 bins, [k, k+1) for k = 0–48 and [49, 50], one distinct palette colour each, no data transparent. Write a
  geographic tile pyramid, levels 0–4 (2×1 … 32×16 tiles of 256 px), every tile including empty ones (a missing
  tile is a 404 the layer would count as a failure), to `public/data/hfp/<year>/{z}/{x}/{y}.png`, and
  `public/data/hfp.json` with the years, tile template, palette and source. ~23 MB for five epochs (measured 3.4 MB
  for one 8192 image).
- **Layer** `src/data/humanFootprint.js`: a drape (exclusive, in compare) on Cesium's geographic tiling scheme,
  maximum level 4, driven by `hfp.json`; on the time bar 2000–2024, drawing the epoch at or before the observed time
  (before 2000: hidden, the gap named). Readout: the level-4 tile pixel through the exact PNG reader, looked up in the
  manifest palette; an unknown colour is named. Share token `hf`.

## Not in scope

Other years (Q13 (b), addable later), 1 km detail, a per-year legend beyond the ramp.

## Acceptance

- `pytest pipeline/tests/test_hfp.py` and `npm test` green; new tests seen to fail first; mutants caught.
- A real pipeline run (jobd) writes five epochs; its size is reported.
- `node scripts/qa-human-footprint.mjs` against a local build exits 0: the layer draws; readouts at a city centre,
  deep Amazon and open sea fall in the range the 1 km source holds around each point (an independent Python read of
  the GeoTIFF); the time bar steps epochs (2010 → 2006); every pixel of the tiles read decodes; no page errors.
- Perf gates equal, or a measured, explained acceptance.
