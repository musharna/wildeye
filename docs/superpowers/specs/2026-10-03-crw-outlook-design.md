# Coral bleaching heat stress outlook, next four months, from NOAA Coral Reef Watch (2026-10-03)

Wave 2, PR 3 (grill `grill_wildeye_wave2_2026-10-03`).

## Outcome

- **Coral bleaching heat stress outlook, next four months** (`crw-outlook`, token `bo`, 🔮): the newest weekly issue
  of NOAA Coral Reef Watch's Four-Month Coral Bleaching Heat Stress Outlook v5 (CFSv2 ensemble, 0.5°), drawn as the
  four-month composite at **60% probability** (the stress level reached by at least 60% of the model runs) in CRW's
  own colours: Watch, Warning, Alert Level 1, Alert Level 2. No-stress and land are clear.
- A click reads the cell at 60% and at 90% (CRW's two headline outlook maps), e.g. `Alert Level 2 reached by 60% of
  model runs; Watch by 90%` · `outlook 2026-10-05 to 2027-01-31`. The level at P% is the highest level that P% of runs
  reach, so a 0 reads "fewer than P% of model runs reach Watch", never "P% predict no stress". Land reads no data.
- Legend: the four levels and a caption naming the window, the probability, the issue date and that the outlook is
  computed for all ocean, reefs or not.
- A forecast, not an observation: it is not on the time bar and always shows the newest issue.

## Source (read live 2026-10-03)

- `https://www.star.nesdis.noaa.gov/pub/socd/mecb/crw/data/outlook/v5/nc/v1/outlook/<year>/`, one NetCDF per
  probability (10%–100%) per weekly issue, e.g. `cfsv2_outlook-060perc_4mon-and-wkly_v5_icwk20260927_for_20261011to20270131.nc`
  (352 KB). `CRW_BAA_FourMonth` is 0–4 on a 720×360 grid, latitude north-up, longitude 0.25..359.75; land and
  missing cells are the fill value and `surface_flag` ≠ 0. The window comes from the file's `time_coverage_start` /
  `time_coverage_end` (exclusive): 2026-10-05 to 2027-01-31 for this issue, although the filename says `for_20261011`.
- CRW's own map of each file (`image_plain/<year>/cfsv2-outlook-4mon_v5_icwk…_060pct_….gif`, 720×360, 0..360°)
  equals the NetCDF on all 171,722 water cells at 60% and at 90%; land is grey (150,150,150). Its colours are the
  palette used here. Both directories answer `Access-Control-Allow-Origin: *`.
- At every water cell the 60% level is at least the 90% level (checked on this issue; the pipeline refuses a file
  pair where it is not).

## Licence

The files' `license` attribute: "The data are available for use without restriction, but it is required to credit
NOAA Coral Reef Watch program." Credit: "Courtesy NOAA Coral Reef Watch" (the existing `noaa-crw` credit, extended
to name the outlook).

## Design

`pipeline/raster.py` routes a product with `crw_outlook` to `pipeline/crw_outlook.py`, which finds the newest issue
with both probabilities (newest year directory first, the year before when the new one is still empty), reads both
composites, checks grid, levels, flags, dates and the 60% ≥ 90% order (any break is an error, the previous manifest
entry is kept as stale), and writes `rasters/crw-outlook.png` (the drape) and `rasters/crw-outlook.data.png`
(R = 60% level, G = 90% level, 255 = land, opaque). The manifest entry carries the window, issue and the readout
image's path. The daily raster cron picks it up with the other products (~4 s, ~57 KB). The frontend wraps the
generic raster drape (`src/data/crwOutlook.js`) and adds the readout.

## Acceptance

- `pytest pipeline/tests/test_crw_outlook.py` on real crops of the 2026-09-29 issue; `npm test` with
  `crwOutlook.test.mjs` and the registry pin (51 → 52).
- `node scripts/qa-crw-outlook.mjs --url <local build with the pipeline's output>` exit 0: the issue shown is CRW's
  newest; the drape equals CRW's 60% map and the readout image equals CRW's 60% and 90% maps on every one of the
  259,200 cells; clicks on cells picked from CRW's maps (two levels that differ, 90% below Watch, one level at both,
  no stress, land) read their levels, also through WHAT LIVES HERE; legend; no page errors.
- Mutants via `mutate-run` against the pytest file, the unit tests and the QA.

## Constraints

No other layer changes (the raster drape gains a read-only `getEntry()`). Out of scope: the weekly outlooks, the
other probabilities, CRW's "probability of reaching level X" maps, an archive on the time bar.
