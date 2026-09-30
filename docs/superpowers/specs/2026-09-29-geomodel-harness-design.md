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

Sample size: 30 species per collection (fewer where the collection or the data run out).

## Controls (a run with a failed control writes no verdicts and exits non-zero)

- **Planted fake**: for one real species per group, replace its presences with background draws (a
  species that is pure effort). Its TSS must be < 0.10.
- **Positive control**: score a synthetic range made of the buffered presences themselves. TSS must be
  ≥ 0.60.
- **Tile agreement**: for 3 species, rasterise the GeoPackage range and the live thresholded tiles at
  z3 over the same pixels; intersection-over-union must be ≥ 0.85, or what is tested is not what is
  shown. Run first (random species from the first collections), so an iNaturalist outage stops the run
  before any GBIF work (the first full run lost 25 minutes to a 503 "downtime" here).
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
