# S3 pilot: are cities hotter than cropland at the same greenness? (pre-registration)

Written and committed 2026-09-24, **before any measured run**. Grill ledger:
`~/.claude/projects/-home-mjarnold/memory/grill_wildeye_s3_heat_greenness_2026-09-24.md`.

**Question.** Is daytime land surface warmer in cities than in cropland in the same region, at the same greenness? Night-time lights, vegetation (EVI) and temperature (LST) are separate NASA products on the site. Only their overlap can separate "cities are hotter" from "cities are less green".

## Data

- **Sources.** NASA GIBS, the same tiles and colour-map decode tables the live site uses (`public/data/gibs.json` → `decode`/`classes`). There is one exact palette lookup per pixel, and an unknown colour is an error, never snapped.
- **Land cover.** MODIS IGBP, latest year, level 8 (~600 m).
- **EVI.** MODIS Terra, latest 16-day composite, level 9.
- **LST.** MODIS Terra day, latest 8-day composite, level 7, converted to °C. Cloud holes (transparent pixels) are dropped and counted. Both composite dates are printed.
- **Points.** Every land-cover pixel centre in each region box. Each point takes the EVI and LST pixels containing it.
- **Regions.** 1° × 1° boxes centred on these points, named here before any data is seen:

| region       | centre (lat, lon) |
| ------------ | ----------------- |
| Chicago      | 41.88, -87.63     |
| Delhi        | 28.61, 77.21      |
| Cairo        | 30.05, 31.24      |
| Manaus       | -3.10, -60.02     |
| Paris        | 48.86, 2.35       |
| Beijing      | 39.90, 116.40     |
| Kano         | 12.00, 8.52       |
| Córdoba (AR) | -31.42, -64.18    |

- **Groups.** City = IGBP "Urban and Built-up Lands"; cropland = IGBP "Croplands". Forest classes (IGBP 1–5, pooled) are plotted for context only.

## Method (per region; regions are never pooled)

1. Bin EVI into 0.02-wide bins. Only bins holding both city and cropland points count.
2. **Matched gap** = Σ_bins n_city(b) · (mean LST city(b) − mean LST crop(b)) / Σ_bins n_city(b).
3. **Unmatched gap** = mean LST city − mean LST cropland, printed beside the matched gap.
4. **95% CI**: 1,000 bootstrap resamples of the points within the region (city and cropland resampled separately), percentile interval of the matched gap.
5. **Null**: 1,000 within-region shuffles of the city/cropland labels among the city and cropland points, matched gap recomputed each time. p = share of shuffles ≥ the observed gap.
6. **Testable** = at least 30 city points and 30 cropland points in shared bins ("matched pairs"). The matched EVI distributions are printed per region.

## Pass / fail (fixed now; a failure is reported, never retuned)

- **Harness control, which must pass first or the run is void (exit 2):** mean LST at Sahara-barren points is greater than at Amazon-forest points, decoded by the same code (the four qa-readout known points).
- **Site agreement, which must pass or the run is void (exit 2):** 50 random sampled points are read through the live site's `readoutAt`. Every class and value interval must agree exactly with the offline decode.
- **PASS** needs all of the following:
  - at least 4 testable regions;
  - in at least 75% of the testable regions, the matched gap is > 0, its 95% CI excludes 0, and it exceeds 95% of that region's shuffles (p < 0.05).
- **Honest-fail readings, printed whatever the outcome:**
  - the unmatched gap is > 0 but the matched gap is not: "cities are just less green";
  - fewer than 4 testable regions: "not testable at this resolution".

## Positive control on the statistics (before real data)

The gap estimator, bootstrap and shuffle must behave on synthetic data:

- a planted +2.0 °C city effect at matched EVI is recovered (95% CI contains 2.0 and excludes 0, p < 0.05) at a realistic size (300 city points, 3,000 cropland points);
- a planted 0 °C effect is not declared a pass;
- a planted pure greenness effect (cities less green, no heat effect) gives an unmatched gap > 0 but a matched gap CI that covers 0.

## Outputs (committed pass or fail)

- `docs/analysis/s3_heat_greenness_regions.csv`: per region, n, dates, gaps, CI, p, testable.
- `docs/analysis/s3_heat_greenness_bins.csv`: per region × EVI bin × group, n and mean LST.
- `docs/analysis/s3_heat_greenness.png`: one figure, one panel per region, LST against EVI by group, matched gap and CI in the panel strip. R + ggplot2, drawn in `docs/analysis/wildeye_theme.R`.
- One sentence in the grill ledger.

## Result (added 2026-09-24, after the run; nothing above was edited)

**FAIL.** 7 regions were testable; Manaus has no cropland in its box. 4 passed: Kano +1.62 °C, Beijing +1.21, Cairo +0.68, Delhi +0.36. Passing needed 6. In the other 3, cities read cooler than cropland at the same EVI: Córdoba −0.80, Chicago −1.36, Paris −1.95. No region showed the "just less green" pattern (unmatched gap > 0, matched gap ≤ 0).

- **Harness control:** passed. Sahara barren 308.3 K, Amazon forest 298.1 K.
- **Site agreement:** passed, 150/150 (50 points × 3 layers). Evidence: `s3_heat_greenness_site_check.json`.
- **Script:** `analysis/s3_stats.py`. Figure: `s3_heat_greenness_figure.R`.

**Deviations, all made before any gap was computed:**

1. **Coordinates written at full precision (the first check failed 35/150).** A level-8 land-cover centre lies exactly on a level-9 EVI pixel edge. The sampler wrote coordinates to 5 decimals, which moved the site's read one EVI pixel over. The CSV now holds full-precision coordinates. The same run found a CRLF parsing bug in the check itself.
2. **The site check re-reads a point whose tile fetch errored, up to 3 times.** 4 fetch errors occurred on one run and none on the final run; their cause was not established.

**Caveat.** About 4 land-cover points share one LST pixel, so points are not independent and the CIs and p-values are too narrow. Correcting this could only remove passes, so the verdict stands. Paris, Chicago and Córdoba are the mid-latitude regions near harvest or fallow in mid-September. Whether the result holds in another season is untested.
