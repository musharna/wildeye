# Geomodel validation harness — design (2026-09-29)

Step 1 of the bio-interpolation wave (grill: `grill_wildeye_bio_interpolation_2026-09-29`). Nothing
modeled ships on the globe until this harness says the model's taxon group passed.

## Outcome

`pipeline/geomodel_check.py`, run monthly, writes `public/data/geomodel_verdicts.json`: for each of the
13 iNaturalist geomodel collections, `pass`, `fail` or `insufficient`, with the numbers behind it. The
species card (step 2) shows iNaturalist's modeled range only for species in a `pass` group.

## What is tested

The iNaturalist Open Range Maps (CC BY 4.0): one GeoPackage per collection on AWS Open Data
(`inaturalist-open-data/geomodel/geopackages/latest/`), a range polygon per taxon, thresholded at the
geomodel's "Seen Nearby" threshold, version in `geomodel_version`. The site will show the same model's
`/v2/geomodel/{id}/{z}/{x}/{y}.png?thresholded=true` tiles; an agreement check ties the two (below).

## Per species

For a random sample of species (rank `species`) in the collection, uniform over the GeoPackage:

- **Presences**: GBIF occurrences of the species that are NOT from iNaturalist (datasetKey
  `50c9509d-22c7-4a22-a47d-8c48425ef4a7` excluded client-side; GBIF cannot negate a dataset), CC0 or
  CC BY, with coordinates and no geospatial issue. Up to 500, a spatial random sample: a species with
  ≤ 3,000 records is read whole and subsampled; a commoner one in 25 draws, each descending from the
  whole world through quadrants chosen in proportion to GBIF's record counts until a box holds ≤ 10,000
  records (or is 1° across), then a page at a random offset in it. Independent of
  the model's training source. The model's own iNaturalist records (for the baseline) are sampled the
  same way.
  *Ruling 2026-09-29, before the first full run:* "random offsets" over the whole species failed on
  both counts. GBIF's index order groups records by dataset (house sparrow: 56% of records in the US,
  none in the first 10,000), and pages past offset 10,000 take minutes (9,700: 1.6 s; 10,300: 358 s).
- **Background**: points drawn in proportion to the non-iNaturalist GBIF record count of the whole
  collection's taxon (target group), from GBIF's count tiles (`/v2/map/occurrence/adhoc/…mvt`, all
  records minus iNaturalist). This is the effort control: a range that only redraws where people record
  catches background points as often as presences.
- **Score**: true skill statistic TSS = (share of presences inside the range) − (share of background
  inside the range). 0 = no better than effort; 1 = perfect.
- **Baseline**: the species' own iNaturalist records (the model's training source), each buffered by
  one radius chosen so the buffers' total area equals the model range's area; TSS computed the same way.
  The model must add something over "circles around the dots at the same area".
- A species with fewer than 30 presences is skipped and counted, not scored.

## Per group verdict (fixed before the first run)

- `insufficient` if fewer than 10 species could be scored.
- `pass` if ALL of: median model TSS ≥ 0.40; the model beats the baseline on more species than it
  loses (ties dropped) with a one-sided sign test p < 0.05; the run's controls passed.
- `fail` otherwise. Thresholds change only in a commit that says why, never after reading a run.

*Ruling 2026-10-02, maintainer, after the Oct 2 run (5213) flipped four collections fail→pass:* the rule
above is now each run's `month_verdict`; the published `verdict` carries evidence across months. Sept and
Oct win shares differ beyond a permutation test in 0 of 13 collections, so the flips were sampling noise,
and a collection judged on one month at a time is listed with no real edge in 20-48% of years
(`analysis/verdict_stability.py`, 2000 simulated years on the two runs' 60 species per collection; 60
species a month, two passes in a row and a three-month pool each failed a ≤ 5% budget for false listings or
for dropping a collection with an edge). Instead, a sequential probability ratio test on species wins and
losses (ties dropped): H0 the model beats the baseline on half the species, H1 on 60%, alpha 0.05, beta
0.10. Each run adds wins·ln(0.6/0.5) + losses·ln(0.4/0.5) to the collection's evidence.
- Listed (`pass`) once evidence ≥ ln(0.9/0.05) = 2.89 on a month whose median model TSS ≥ 0.40.
- Dropped at evidence ≤ ln(0.1/0.95) = −2.25, and the evidence starts again at 0.
- Evidence is capped at 5.89 (2.89 + 3), so a listed collection that stops beating circles drops within
  months, and floored at −2.25 while not listed, so months of losses cannot bank unrepayable doubt.
- A month with too few species (`insufficient`) adds nothing and keeps a listing.
- The evidence lives in the verdicts file (`evidence: {llr, months}`) and carries only between runs of the
  same geomodel version; a new version starts at 0. A file from before this ruling counts as one month.
Simulated, a no-edge collection lists in ≤ 3.5% of years and none of the 8 collections with a pooled
edge ≥ 58% drops (H1 0.60 picked over 0.65 and 0.70 and caps 3 and 6 in
`analysis/verdict_stability_sweep.py`, after the budgets were set). On the real runs it lists Arachnida,
Insecta and Mollusca, and holds Actinopterygii (evidence 1.21) and Plantae (2.02) that October's own sign
test passed. `--rejudge FILE` judges a saved run again against `--prior` without network work.

Sample size: 30 species per collection (fewer where the collection or the data run out).

## Controls (a run with a failed control writes no verdicts and exits non-zero)

- **Planted fake**: for one real species per group, replace its presences with background draws (a
  species that is pure effort). Its TSS must be < 0.10.
- **Positive control**: score a synthetic range made of the buffered presences themselves. TSS must be
  ≥ 0.60.
- **Tile agreement**: for 26 species, two in each of the 13 collections (drawn round-robin across the
  collections in a fresh random order each run; or all species if fewer),
  rasterise the GeoPackage range and the live thresholded tiles at z3 over the same pixels; the median
  intersection-over-union must be ≥ 0.85, or what is tested is not what is shown. Every species' IoU is
  recorded. Run first, so an iNaturalist outage stops the run before any GBIF work (the first full run
  lost 25 minutes to a 503 "downtime" here).
  *Ruling 2026-09-30, maintainer, after a run failed on it:* the first rule (each of 3 species ≥ 0.85)
  failed when tiles and GeoPackage agree: of 20 random birds, 15 scored ≥ 0.85 and 5 scored 0.80–0.83
  (ranges under 2.5 M km², coarse at z3), so 3 draws passed about 42% of the time. One real mismatch
  (Anser cygnoides, IoU 0.03: tiles far broader) is a property of that species, not of the run; step 2
  checks agreement per species before showing a tile range.
  *Ruling 2026-10-02, maintainer, after the Oct 1 monthly run failed on it (median 0.8247 over 10):* the
  same day's tiles reproduced every IoU of both the Sept 30 and Oct 1 draws exactly (geomodel 2.34), so
  nothing drifted. 129 random species over all 13 collections (median 0.911, 14% below 0.80) put the false
  failure rate of 10 species, one per collection, at about 2.7% of months, and Oct 1's draw at about 1 in
  200. Two per collection (26) at the same 0.85 fails about 0.15% (bootstrapped); the bar is unchanged, so
  the check's power to see real drift is not traded away. The run takes about 8 minutes longer.
  Species whose GeoPackage range is empty (header flag 0x10; Comatricha nigra, Protozoa) are not listed:
  drawn here, one crashed the run on NaN bounds instead of failing a control.
- **Planted-effect ladder** (unit tests, calling the harness's own `tss()` and `group_verdict()`):
  synthetic species whose true TSS is 0.0, 0.2, 0.4, 0.6 and 0.8 must come back within ±0.05, and the
  verdict must flip between 0.2 and 0.6 — the smallest effect the rule can see, so a `fail` is a bound.
- **Shuffle null**: swapping presence and background labels at random (the exchangeable unit is the
  point) must give |TSS| < 0.05 on real data from the first run; the real TSS must not.
- **Effort placement** (added 2026-09-29, before the first full run): GBIF's count tiles rebuilt over a 6 x 6
  block of grid cells (birds around Switzerland) must agree with GBIF occurrence search over the same cells to
  an L1 error ≤ 0.40 of the block's records. The z3 tiles the grid was first built from scored 2.57 (records
  a cell or more from where they are); z4 scores 0.22. Checked first, so a bad background stops the run
  before any scoring.
- **Exclusions are findings**: every skipped species and why (too few presences, no GBIF match) is
  counted in the verdicts file, never silently dropped.
- **El-Gabbas cross-check** (once, recorded in the PR, not every run): Spearman correlation between our
  all-records bird effort and El-Gabbas (2026, Zenodo 17591681, CC BY 4.0) at a matched grid.

## Constraints

- Network: GBIF API and AWS Open Data only in the monthly run; iNaturalist tile API only for the 3
  agreement species at ≤ 1 request/s. GeoPackages are cached by version and deleted after the run.
- Python under `pipeline/`, run by `$WILDEYE_PYTHON`; no new packages (numpy, shapely, pyproj present;
  GBIF's vector tiles decoded by a small stdlib reader).
- Nothing about the site changes in this step; the verdicts file is the only output.

## Acceptance check

`python3 -m pytest pipeline/tests/test_geomodel_check.py` exits 0, and one real run
(`pipeline/run_geomodel_check.sh`) writes verdicts for all 13 collections with every control passing.

## Rulings

- The grill's "spatial block hold-out" was written for a model we train. The geomodel is trained
  elsewhere on iNaturalist records, so the hold-out is a different source (non-iNaturalist GBIF) and
  the leak that blocks guard against is covered by the equal-area nearest-record baseline.
- Readout bands follow iNaturalist's own threshold: above = "expected nearby", below = "modeled,
  below threshold". Transparency in the continuous tile overlaps across the threshold (robin z2: inside
  p1 106, outside max 182), so no numeric value is decoded.
