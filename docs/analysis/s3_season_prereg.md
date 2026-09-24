# S3 season rerun: a fairer test of city vs cropland heat at matched greenness (pre-registration)

Written and committed 2026-09-24, **before any 2024 tile is fetched**.

- Grill ledger: `~/.claude/projects/-home-mjarnold/memory/grill_wildeye_s3_season_2026-09-24.md`.
- Pilot: `s3-heat-greenness-prereg.md`. It FAILED 4/7 on one mid-September 2026 composite. That result stands and is not replaced.

**Question (unchanged).** In the same region, at the same greenness (EVI), is daytime land surface warmer in cities than in cropland?

**What is made fairer.** The pilot had three problems, and each is fixed here:

1. **Season.** It used one mid-September week, which is harvest or fallow in the 3 regions that failed. Here each region's verdict is taken at its own greenest-cropland date, chosen from EVI alone.
2. **Year.** Its imagery was from 2026 against a 2024 land-cover map. Here everything is 2024.
3. **Counting.** About 4 points shared each temperature pixel, so CIs and p were too narrow. Here each temperature pixel is one unit.

## Data (all 2024)

- **Land cover.** MODIS IGBP 2024-01-01, level 8.
- **EVI.** MODIS Terra 16-day, level 9. All 23 composites of 2024: 2024-01-01 + 16k days, k = 0..22.
- **LST.** MODIS Terra day 8-day, level 7. For the EVI composite starting on day d, LST is taken from the two 8-day composites starting on d and d+8, which together cover the same 16 days.
- **Access.** Tiles are fetched as in the pilot:
  - the same decode tables (the live site's `data/gibs.json`);
  - an unknown colour is an error;
  - every tile's `layer-time-actual` header must equal the requested date.
- **Regions, boxes, groups.** Same as the pilot: 8 named 1° boxes; city = "Urban and Built-up Lands", cropland = "Croplands".

## Unit: the pure LST pixel

- **Which pixels.** Every level-7 LST pixel whose centre lies in a region's box. Nesting is exact by index: global pixel g at level 7 holds level-8 pixels 2g+{0,1} and level-9 pixels 4g+{0..3}, per axis.
- **Class.** A pixel is **city** (or **cropland**) only if all 4 of its land-cover pixels are that class. Mixed pixels are dropped.
- **EVI.** The mean of the midpoints of its 16 EVI pixels, excluding cloud holes and wide bins. It needs ≥ 8 valid of 16, else the pixel is dropped for that date.
- **LST.** The mean of the midpoints of the cloud-free, non-wide values of its two 8-day composites, converted to °C. It is a cloud hole, and dropped for that date, only if neither is usable.

## Method

- **Per region and date:** the pilot's statistics, unchanged, with pixels in place of points:
  - 0.02 EVI bins;
  - matched gap = Σ n_city(b)·(mean city − mean crop)/Σ n_city;
  - 1,000 bootstrap resamples (city and cropland separately), percentile 95% CI;
  - 1,000 within-region label shuffles, p = share ≥ observed;
  - testable = ≥ 30 matched city and ≥ 30 matched cropland pixels.
- **Peak date:** the 2024 EVI composite whose median EVI over the region's pure cropland pixels is highest. It is computed from EVI only; no LST is read to choose it. A region with no cropland pixels has no peak date and is not testable.
- **September arm:** EVI composite 2024-09-13, with LST 2024-09-13 + 2024-09-21. It is the 2024 counterpart of the pilot's dates (EVI 2026-08-29, LST 2026-09-14).
- **Engagement gate:** a region is "engaged" if its peak-date median cropland EVI is greater than its September-arm median cropland EVI.
- **Curve:** gap and 95% CI for every region × 2024 date. It is descriptive only; no date other than the peak decides anything.

## Pass / fail (fixed now; a failure is reported, never retuned)

- **Harness control:** the Sahara barren pixel's LST is greater than the Amazon forest pixel's, on the peak date used for the site check. Otherwise the run is void (exit 2).
- **Site agreement:** the live site is scrubbed to one 2024 date via its time bar (`__godsEyeView.observedTime`). That date is the one that is the peak for the most regions; ties go to the earliest.
  - 50 random sampled land-cover pixels are read for land cover, EVI and LST, the LST being the site's single composite for that date.
  - Every class and interval must agree exactly with the offline decode.
  - The date the site shows must equal the requested date.
  - Otherwise the run is void (exit 2).
- **PASS** (the pilot's rule, unchanged):
  - at least 4 regions are testable at their peak date;
  - in at least 75% of them, the peak-date matched gap is > 0, its 95% CI excludes 0 and p < 0.05.

## Readings, fixed now and printed whatever the verdict

These apply to each region that failed in the pilot (Paris, Chicago, Córdoba):

- **Harvest idea supported:** engaged; peak gap > 0 with the CI excluding 0; September-arm gap < 0 with the CI excluding 0.
- **Harvest idea refuted:** engaged, and peak gap < 0 with the CI excluding 0.
- **Year or counting, not season:** the September-arm gap is > 0 with the CI excluding 0.
- **Unresolved:** anything else, including not engaged or not testable.

## Positive controls on the statistics (before real data)

- A planted +2.0 °C city effect at matched EVI is recovered at pixel level (CI contains 2.0 and excludes 0, p < 0.05) with Kano-sized counts: 139 city pixels and 7,800 cropland pixels.
- A planted 0 °C effect is not declared a pass.
- A pure greenness effect gives an unmatched gap > 0 but a matched-gap CI covering 0.
- **Pseudo-replication control:** 0 true effect plus a shared per-pixel noise term. Treating the 4 points per pixel as independent units must over-reject (the pilot's flaw); using the pixel as the unit must not.

## Outputs (committed pass or fail)

- `docs/analysis/s3_season_regions.csv`: per region, the peak date, the engagement gate, the peak and September-arm rows (n, gaps, CI, p, testable, passes) and the reading.
- `docs/analysis/s3_season_curve.csv`: per region × date, n, gap, CI, and the median cropland and city EVI.
- `docs/analysis/s3_season_verdict.png`: the pilot's figure at each region's peak date.
- `docs/analysis/s3_season_curve.png`: the gap and CI through 2024 per region, with median cropland EVI on the same time axis; the peak and the September arm are marked.
- One sentence in the grill ledger.

## Result (added 2026-09-24, after the run; nothing above was edited)

**PASS.** 6 of 7 testable regions pass at their peak-greenness date; 6 were needed. Manaus has no cropland, so it has no peak date and can't be tested.

| region | peak date | gap at peak, °C [95% CI] | pass | Sep-2024 arm gap [CI] | reading |
|---|---|---|---|---|---|
| Kano | 2024-08-28 | +5.55 [+4.08, +6.14] | ✓ | +5.40 [+4.38, +5.88] | — |
| Paris | 2024-05-08 | +3.91 [+3.65, +4.22] | ✓ | +2.67 [+2.53, +2.76] | year or counting, not season |
| Chicago | 2024-07-27 | +1.45 [+0.83, +1.95] | ✓ | +0.87 [+0.66, +1.08] | year or counting, not season |
| Córdoba | 2024-03-05 | +0.98 [+0.54, +1.26] | ✓ | −2.38 [−2.52, −2.22] | harvest idea supported |
| Delhi | 2024-08-28 | +0.86 [+0.62, +1.07] | ✓ | +1.16 [+0.98, +1.23] | — |
| Beijing | 2024-08-12 | +0.82 [+0.65, +0.92] | ✓ | +0.39 [+0.26, +0.53] | — |
| Cairo | 2024-02-02 | −0.21 [−0.42, +0.29] | ✗ | +0.39 [−0.05, +0.49] | — |

**Controls.**
- **Harness:** passed. Sahara 313.1 K vs Amazon forest 303.5 K, at 2024-08-28.
- **Site agreement:** passed, 150/150 (50 points × 3 layers). The site was scrubbed to 2024-08-28 and showed land cover 2024-01-01, EVI and LST 2024-08-28. Evidence: `s3_season_site_check.json`, `s3_season_peaks_and_control.json`.
- **Engagement gate:** engaged in all 7 testable regions. Cropland was greener at the peak than in September: Córdoba 0.68 vs 0.18, Paris 0.58 vs 0.37, Chicago 0.65 vs 0.43.

**Readings.**
- **Córdoba:** the harvest idea is supported. Cities read 2.4 °C cooler than fallow cropland in September and 1.0 °C warmer at peak crop.
- **Paris and Chicago:** cities were already warmer in September 2024. The pilot's negative gaps there came from its year (2026 imagery against a 2024 land-cover map) or its counting (mixed points rather than pure pixels), not from season. This design cannot say which.

**Shown by the curve but not tested (descriptive only).**
- In Delhi, Córdoba and Beijing the gap is negative through the fallow or dry months and positive at crop peaks. At the same EVI, bare or sparse cropland is hotter than city.
- In Paris the gap is positive almost all year.

**Deviations, all before any 2024 LST was examined:**
- The pseudo-replication control uses a pooled-null rejection rate over 400 simulated regions instead of per-run p-values. The 60-run version could not reliably tell 20% from 5%.
- An extra output, `s3_season_bins.csv`, feeds the verdict figure.
