# S3 follow-up: year or counting? (diagnostic, written before the run)

Written and committed 2026-09-24, before any number below was computed. This is a **diagnostic**, not a new pre-registered claim.

**Question.** The pilot (September 2026) found cities cooler than cropland at matched EVI in Paris (−1.95 °C) and Chicago (−1.36 °C). The season rerun's September 2024 arm found them warmer: Paris +2.67, Chicago +0.87 (`s3_season_prereg.md`).

The two runs differ in the data and in the method:

- **Year.** The pilot used EVI 2026-08-29 and LST 2026-09-14. The season arm used EVI 2024-09-13 with the LST pair 2024-09-13 and 2024-09-21.
- **Counting.** The pilot's unit is every land-cover point, taking its own class. About 4 points share each LST pixel, and mixed pixels are kept. The season arm's unit is the pure LST pixel, with the mean of its 16 EVI pixels.

Which one flips the sign?

## Arms (all 7 testable regions; Paris and Chicago decide)

- **P, the pilot:** point method on 2026 data. Already on record (`s3_heat_greenness_regions.csv`).
- **A, the pilot's point method on 2024 data:** code identical to `analysis/s3_sample.py` and `analysis/s3_stats.py`. The only change is fixed 2024 dates:
  - land cover 2024-01-01;
  - EVI 2024-09-13;
  - a single LST composite 2024-09-13, as in the pilot.
- **A-pure:** arm A restricted to points whose LST pixel is pure, with all 4 of its land-cover points one class. It separates mixed pixels from the other method differences.
- **B, the season rerun's September arm:** already on record (`s3_season_regions.csv`).

## Reading (for Paris and for Chicago separately)

- **Counting, not year:** A gap < 0 with the 95% CI excluding 0. The same 2024 data gives a negative gap under the pilot's method.
- **Year, not counting:** A gap > 0 with the CI excluding 0. The pilot's own method gives a positive gap on 2024.
- **Unresolved:** otherwise.
- **Mixed pixels:** if the reading is "counting", A-pure > 0 says mixed pixels drive it; A-pure < 0 says the rest of the method (EVI aggregation or the LST pair) does.

**Caveats, fixed now.**

- Arm A's CIs are point-unit and too narrow, as in the pilot. Only the sign of a gap well away from 0 is read.
- "Year" also includes a two-week offset in the EVI date: 2026-08-29 in the pilot vs 2024-09-13 here.

## Outputs

- `docs/analysis/s3_year_vs_counting.csv`: per region, the gap, CI and n for arms P, A, A-pure and B, and the reading.
- One line in the grill ledger.
