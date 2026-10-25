# Loss drivers: drawn tiles vs the raw v1.13 category GeoTIFFs

Written by `analysis/loss_drivers_tiles_vs_raw.py` on 2026-10-25: 210 cell centres in 10N_060W (Amazon), 00N_110E (Borneo), 60N_120W (Canada), 40N_010W (Iberia); raw classes seen: [1, 2, 3, 4, 5, 6, 7].

- level 12: the drawn colour names the raw class at 210 of 210 points
- level 8: the drawn colour names the raw class at 206 of 210 points

Every point is in `docs/analysis/loss_drivers_samples.tsv`; the table lists those where a level disagreed.

| region | lat | lon | raw | level 12 | level 8 |
|---|---|---|---|---|---|
| Amazon | 5.24088 | -57.72088 | 4 | 4 | 0 |
| Amazon | 2.90062 | -51.03088 | 7 | 7 | 5 |
| Amazon | 7.56062 | -59.58388 | 7 | 7 | 0 |
| Borneo | -9.73387 | 119.86912 | 1 | 1 | 0 |
