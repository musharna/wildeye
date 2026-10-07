# Dominant phytoplankton group, monthly, from Copernicus-GlobColour (2026-10-07)

Wave 4, layer 2 (grill `grill_wildeye_wave4_2026-10-07`, decisions 1, 3, 4, 5).

## Outcome

- **Dominant phytoplankton group** (`cmems-pft`, token `pf`, 🔬): for each 0.25° ocean cell, the group with the most
  chlorophyll a in the latest month of satellite estimates, one of diatoms, dinoflagellates, haptophytes, green algae
  and prochlorophytes, prokaryotes. Cells with no satellite estimate that month (cloud, sea ice, polar night, land)
  are clear.
- Monthly frames on the time bar (a frame per month, kept about 13 months); the daily raster cron re-fetching the
  same month writes no second frame.
- A click reads the group of the cell from the frame on show, e.g. `diatoms · September 2026`; a clear cell reads
  `no satellite estimate: land, or no clear view this month (cloud, sea ice, polar night)`.
- Legend: one colour per group and the caption `group with the most chlorophyll in each cell, satellite estimate,
  monthly mean; clear = no satellite view`.

## Source (read live 2026-10-07)

- Product OCEANCOLOUR_GLO_BGC_L4_NRT_009_102 (doi 10.48670/moi-00279), dataset
  `cmems_obs-oc_glo_bgc-plankton_nrt_l4-multi-4km_P1M` (version 202411) through `copernicusmarine.open_dataset`
  2.4.1: DIATO, DINO, HAPTO, GREEN, PROKAR, PROCHLO, CHL (+ MICRO/NANO/PICO, uncertainties, `flags` = LAND),
  float32 mg m⁻³, 8640×4320 at 1/24°, latitude ascending from -89.98, longitude from -179.98. NRT holds one step
  (2026-09-01, the September 2026 mean).
- Algorithm inputs (QUID CMEMS-OC-QUID-009-101to104-111-113-116-118 issue 7.0, §I.1): "The concentration of each
  phytoplankton functional type relies on the Xi et al. (2020) algorithm [RD69][RD70] … The algorithm was initially
  implemented using OLCI reflectance in the visible spectrum (bands comprise between 400 and 681 nm) with empirical
  orthogonal function (EOF)." §V.2.6: "The algorithm refinement rises the importance to also consider the Sea
  Surface Temperature as input in addition to the sensor reflectance spectrum." So the inputs are the reflectance
  spectrum (its EOF modes) and SST, not chlorophyll alone. Papers, CrossRef-checked (first author, year):
  Xi et al. 2020, Remote Sensing of Environment 240, 111704, doi:10.1016/j.rse.2020.111704 (Xi, 2020); Xi et al.
  2021, JGR Oceans 126, e2020JC017127, doi:10.1029/2020JC017127 (Xi, 2021: "including sea surface temperature (SST)
  as an additional input parameter").
- Nesting. PUM CMEMS-OC-PUM 7.0 names the groups "DIATO (Diatoms), DINO (Dinophytes or Dinoflagellates) … HAPTO
  (Haptophytes or Coccolitophores), GREEN (Green algae & Prochlorophytes) and PROKAR (Prokaryotes)" and builds the
  size classes from them, "PICO includes GREEN and PROKAR", with no place for PROCHLO. Xi et al. 2020 §2.1.3:
  "Prochlorococcus which is a typical species of prokaryotes"; §2.3 classifies dominance exactly as here: "the five
  PFTs – diatoms, dinoflagellates, haptophytes, green algae and prokaryotes – were compared pixelwise and the one
  with the highest Chl-a concentration was considered as the dominant PFT", Prochlorococcus only splitting the
  prokaryote class. PROCHLO is therefore not a competitor. The groups are retrieved separately and do not add up:
  PROCHLO ≤ PROKAR at only 47.4 % of 4 km pixels, and the five groups sum to a median 1.29 × CHL (premise check).
- Quality (QUID §I.2): good agreement with in-situ pigments except "small cells (prokaryotes, Prochlorococcus and
  Picophytoplankton), which present relatively weaker results with a coefficient of determination of about 0.5".

## Premise check (ledger decision 4): not chlorophyll re-coloured

`python3 -m analysis.pft_premise` (output `docs/analysis/pft_premise.md`), September 2026, 562,941 cells with data
(77.1 % of cells holding ocean): group shares of cells (of area) diatoms 33.8 % (24.9 %), dinoflagellates 0 %,
haptophytes 18.3 % (20.2 %), green algae 14.9 % (15.6 %), prokaryotes 33.0 % (39.4 %). CHL alone predicts the
dominant group for 60.8 % of cells (decision tree on log CHL, 5 leaves), 62.2 % (best 5 CHL intervals, exact DP),
and at most 62.2 % for any function of CHL at 2,000 quantile bins: far below the 95 % stop line. Dinoflagellates
lead nowhere this month (their median share of the winning group's chlorophyll is 0.19); they stay in the legend
because the rule is fixed and other months can differ.

## Licence

Copernicus Marine Service commitments and licence (re-read 2026-10-07), §2.4 (a): "value added products or
derivative works developed from Copernicus Marine Service Products including pictures – shall credit the Copernicus
Marine Service by explicitly making mention of the originator (Copernicus Marine Environment Monitoring Service) and
by citing the DOIs in the following manner: “Generated using E.U. Copernicus Marine Service Information; insert
DOIs links here”". Credit (own key `cmems-globcolour`): "Phytoplankton groups: Generated using E.U. Copernicus Marine
Service Information; Global Ocean Colour (Copernicus-GlobColour) plankton, https://doi.org/10.48670/moi-00279".

## Design

- `pipeline/rasters.json` row with a `cmems_dominant` block (dataset id, block 6) and `kind: "classes"`; each class
  names its variable, so the classes are the one list of competing groups. `pipeline/raster.py` routes it to
  `pipeline/cmems_pft.py` (three lines; `fetch_cmems` and `ramp_rgba` untouched).
- `dominant_group(stack, block)`: a 4 km pixel counts only when all five groups are finite; each group is the mean
  over those pixels in the 6×6 block; argmax (a tie goes to the first class); a cell with no such pixel is -1.
  Painted north-up into a 1440×720 RGBA in the class colours, -1 clear. The 4 km grid is checked (8640×4320,
  1/24° steps from -179.98 / -89.98) and a broken grid fails the product (the previous entry is kept, stale).
- Latest step ≤ today. Frame stamp = the month's first day, so re-fetching the month re-uses the frame
  (`archive_frame` skips an existing stamp); `keep_days: 400`. `pipeline/freshness.py` allows the product 76 days
  (two months plus publication lag) before calling it stale.
- Frontend `src/data/cmemsPft.js`: the generic raster drape plus `readoutAt`, which decodes the frame on show and
  maps the cell's exact RGB to its class.
- Palette (Okabe–Ito, colour-blind safe): diatoms (230,159,0), dinoflagellates (204,121,167), haptophytes
  (86,180,233), green algae and prochlorophytes (0,158,115), prokaryotes (240,228,66).

## Acceptance

- `python3 -m pytest -q pipeline` and `npm test` pass; the new tests were seen to fail before the code.
- Real run: `python3 -m pipeline.raster --out public/data --only cmems-pft` writes `rasters/cmems-pft.png`
  (1440×720) and a manifest entry; an independent xarray read of the raw 4 km data at 6+ cells (Southern Ocean,
  subtropical gyre, coastal upwelling, Arabian Sea, high-latitude summer, a gap) gives the class drawn in the PNG.
- `node scripts/qa-cmems-pft.mjs --url <local build>` exit 0: legend text exact, credit, share token `pf`, click
  readouts at those cells equal the raw-derived group, no console errors.
- `mutate-run` on the argmax/mask/coarsen code and the legend/readout: report killed/total.

## Constraints

No other layer changes; `fetch_cmems` / `ramp_rgba` untouched (the zooplankton drape edits them). Memory: one
month, five float32 fields (~750 MB) at a time. Out of scope (decision 5): size classes, per-group chips,
uncertainty layers, micronekton.
