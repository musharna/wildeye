# Own effort-corrected range surfaces: probe (2026-10-02)

Approach B of the bio-interpolation wave (grill `grill_wildeye_bio_interpolation_2026-09-29`, Q16 (c), Q17 (a),
A22–A24). iNaturalist's Geomodel passed the harness (`2026-09-29-geomodel-harness-design.md`) for Arachnida
only. In the other 12 groups it did not beat equal-area circles around its own records (run 4950,
`public/data/geomodel_verdicts.json`). This probe asks whether a surface we build ourselves, from openly
licensed records weighted by recording effort, does better. Nothing on the site changes; the output is
a verdicts file.

## Outcome

`python3 -m pipeline.own_surface` writes `analysis/own_surface_verdicts.json`: for each of the 13
groups, a verdict (`pass`, `fail`, `insufficient`) on the same species run 4950 scored. Each species has
our surface's TSS and the circles baseline's TSS, cross-validated on held-out spatial blocks.

## Data (all already used by the harness)

- **Species**: the 30 species per group that run 4950 scored (`geomodel_verdicts.json`, by name). Each
  is matched to GBIF again with `match_species`.
- **Records**: `occurrence_points(key, inat=False, want=500)`: CC0/CC BY records not from iNaturalist,
  a spatial random sample. We train and test on these, so the surface could be shipped under the site's
  licence bar. iNaturalist's records on GBIF are a CC BY-NC dataset.
- **Effort**: `effort_grid(group)`, the group's non-iNaturalist CC0/CC BY record counts on the
  512 x 512 Web-Mercator grid (~78 km cells at the equator). Background points are drawn from it as in
  the harness (5,000).

## The surface (fixed before any run)

For a set of training records:
- S = species training records counted on the effort grid; E = the effort grid.
- Both are smoothed by the same Gaussian, sigma in grid cells, wrapping east-west.
- Rate = smooth(S) / (smooth(E) + 1).
- The range is the cells whose rate is at least the rate at the training records' 10th percentile, so it
  keeps 90% of the training records.
- Sigma is chosen from {1, 2, 4, 8, 16} cells by an inner cross-validation on the training blocks only (4
  inner folds, best pooled TSS, ties to the smaller sigma).
  *Ruling, before any run, on synthetic data:* with sigma at most 8 cells (~400–600 km) the surface
  could not fill a held-out 5° block from its neighbours. A planted 20° cluster scored 0.55 cross-validated
  against 0.93 for a perfect range; with 16 it scored 0.69 and 0.80 over two seeds, and 32 added nothing.

Why: dividing by effort is what circles cannot do. Circles follow the dots, and dots follow where people
record. The effort background in TSS penalises exactly that.

## Cross-validation (A22)

- 5° x 5° longitude/latitude blocks, assigned to 5 folds by a seeded permutation.
- For each fold: train on the records outside its blocks; test on the records and background points
  inside them.
- A fold is scored only if it has test records and at least 10 training records.
- TSS is pooled over a species' scored folds: (test records inside their fold's range / all scored test
  records) minus (background points inside their fold's range / all background in scored folds).
- The baseline is the harness's `equal_area_baseline`: circles around the same fold's training records,
  at the same area as that fold's range. It is scored the same way.
- A species with fewer than 30 scored test records is skipped and counted.

## Verdict (Q17 (a), the harness's rule)

`group_verdict` unchanged:
- `pass` if the median TSS is at least 0.40, our surface beats the circles on more species than it loses,
  and a one-sided sign test gives p < 0.05;
- `insufficient` if fewer than 10 species are scored;
- `fail` otherwise.

Thresholds change only in a commit that says why, never after reading a run.

## Controls (a failed control writes no verdicts and exits non-zero)

- **Effort placement**: as the harness, checked first.
- **Planted fake** (per group): the first scored species' records are replaced by background draws, a
  species that is pure effort. Cross-validated TSS must be < 0.10.
- **Positive control** (per group): records are background draws inside one 20° x 20° box, a clustered
  species. Cross-validated TSS, the mean over 5 fold layouts (seeds seed … seed+4), must be ≥ 0.60, so the
  surface can find a real range under this design. *Ruling, before any run, on synthetic data:* one layout
  scored 0.37–0.83 on the same kind of box (9 of 50 below 0.60). A layout that puts half the box's blocks in
  one fold leaves nothing to fill them from: in one case 165 of 300 records were held out together, 35% were
  recovered, and almost no background leaked. Over 10 synthetic worlds the 5-layout mean ranged 0.66–0.79.
  The species scores keep the run's single layout: our surface and the circles share it, so the comparison is
  paired.
- **Shuffle null** (per group, first scored species): presence and background labels swapped at random,
  5 times. The mean must satisfy |TSS| < 0.05. One shuffle's sampling noise is about ±0.023 TSS, which
  would false-fail about 3% of groups and so roughly one run in three; this was fixed before any run.
- **Unit tests** (planted-effect ladder): synthetic clustered species are recovered (TSS ≥ 0.60) and
  pure-effort species are not (|TSS| < 0.10). The verdict rule flips as in the harness. The rate divides
  by effort: a species twice as dense where effort is twice as dense gives a flat rate.

## Not in scope

Showing anything on the site (deferred until a group passes; it would reuse the species card's modeled
range switch); environmental covariates; abundance; comparing TSS with iNaturalist's model directly.
The harness tests iNaturalist on all records with no blocks held out, a different design, so the two
TSS values are not comparable and are not reported side by side.

## Constraints

- Python under `pipeline/`, numpy, shapely and pyproj only, no new packages.
- GBIF only: no iNaturalist calls, no GeoPackages.
- Runs on jobd, overnight.

## Acceptance

- `pytest pipeline/tests/test_own_surface.py` exits 0, with each test seen to fail on a mutant.
- One real run on jobd writes `analysis/own_surface_verdicts.json` for all 13 groups, with every control
  passing.
- The verdicts are reported as they come out. A `fail` everywhere is a valid result and closes approach
  B for these groups.

## Result (2026-10-02): approach B closed, negative

Two jobd runs on the laptop (5180, then 5183 for the other 12 groups) stopped at the first failed control, so
no verdicts file was written and 10 groups never ran. Per-species scores from both runs:
`analysis/own_surface_runs_2026-10-02.tsv` (83 species).

| Group | Controls | Scored | Median TSS, ours / circles | Ours beats circles | Sign test p |
|---|---|---|---|---|---|
| Aves | positive control 0.4954 < 0.60 | 30 | 0.754 / 0.964 | 5 of 30 | 1.000 |
| Mammalia | all passed | 29 | 0.812 / 0.824 | 10 of 29 | 0.969 (`fail`) |
| Amphibia | positive control 0.5499 < 0.60 | 24 | 0.583 / 0.802 | 4 of 22 untied | 1.000 |

Mammalia is the only verdict the design allows, and it is `fail`. In the two groups whose controls failed, our
surface also loses to the circles species by species. Fixing the control would not change that comparison, so
approach B is closed rather than rerun (user, 2026-10-02).

Why the positive control failed, measured on Aves: the box rule (the 20° box with the most background at
most a tenth of it) picked 100–80°W, 40–60°N. 222 of the 300 planted records fell in two 5° blocks on its
southern edge, and the 5° strip just south of the box holds 46% as much effort as the box. A held-out edge
block's neighbourhood is mostly out-of-box effort with no records, so its rate falls below the training
threshold: recall 0.00–0.15 in those folds, about 1.0 elsewhere; 8 layouts scored 0.26–0.56. Holding the
held-out blocks' effort out of the denominator as well moved it only to 0.32–0.57, so that was not the cause.
The synthetic worlds behind the 5-layout ruling had no effort peak beside the box. A reuse of this control
should place the box away from the effort peak.
