# cmems-pft premise check (2026-09-01)

Dataset `cmems_obs-oc_glo_bgc-plankton_nrt_l4-multi-4km_P1M`, time step 2026-09-01, grid 8640x4320.

## Nesting at 4 km

Ocean 4 km pixels (flags LAND = 0): 25,155,477; with all five groups present: 18,291,147 (72.7 %).

- PROCHLO <= PROKAR: 8,674,968 of 18,291,147 pixels (47.427 %)
- PROCHLO <= GREEN: 12,916,896 of 18,291,147 pixels (70.618 %)
- PROCHLO / PROKAR percentiles 5/25/50/75/95: 0.389 / 0.760 / 1.048 / 1.903 / 3.344
- (DIATO+DINO+HAPTO+GREEN+PROKAR) / CHL percentiles 1/5/25/50/75/95/99: 0.458 / 0.744 / 1.041 / 1.289 / 1.676 / 2.463 / 3.264
- same sum plus PROCHLO, median ratio: 1.535

## Dominant group per 0.25 degree cell

Cells with data: 562,941 of 730,133 cells holding any ocean pixel (77.1 %).

| group | cells | share of cells | share of area |
|---|---:|---:|---:|
| DIATO | 190,040 | 33.76 % | 24.85 % |
| DINO | 0 | 0.00 % | 0.00 % |
| HAPTO | 103,179 | 18.33 % | 20.24 % |
| GREEN | 83,974 | 14.92 % | 15.56 % |
| PROKAR | 185,748 | 33.00 % | 39.35 % |

DINO as a share of the winning group's chlorophyll, percentiles 50/99/max: 0.188 / 0.408 / 1.000

## Null arm: CHL alone

- decision tree on log10 CHL, max_leaf_nodes = 5: 60.77 % of cells (57.10 % of area)
- best <= 5 CHL intervals (exact DP over 2000 quantile bins): 62.17 % of cells
  - intervals: CHL 0.0199-0.111 -> PROKAR; CHL 0.111-0.193 -> DIATO; CHL 0.193-0.322 -> HAPTO; CHL 0.322-1.69 -> DIATO; CHL 1.69-50.6 -> GREEN
- ceiling, any function of CHL at that binning (bin majority): 62.22 % of cells

**Verdict**: best CHL-only classifier 62.17 % vs the 95 % stop line: premise holds: the dominant group is not chlorophyll re-coloured.
