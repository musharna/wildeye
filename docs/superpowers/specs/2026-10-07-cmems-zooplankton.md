# Zooplankton carbon at the surface, from the Copernicus Marine global model (2026-10-07)

Wave 4, PR 1 (grill `grill_wildeye_wave4_2026-10-07`, decisions 1, 2, 5).

## Outcome

- **Surface zooplankton carbon (model)** (`cmems-zooc`, token `zc`, 🦐): the newest analysis day (at or before today)
  of total zooplankton carbon in the top model level (0.49 m) from the Copernicus Marine global biogeochemistry
  analysis, drawn on a **log** colour ramp from 0.05 to 5 mmol C/m³ (purple → yellow). Land is clear. Daily, on the
  time bar like `cmems-o2` / `cmems-ph` (30 archived days).
- Legend: `0.05 mmol C/m³` · `0.5 mmol C/m³` · `5 mmol C/m³` swatches, then the caption, exactly:
  `zooplankton carbon at the surface, daily, log scale: purple = little · yellow = a lot. A model value (PISCES biogeochemical model in the Copernicus global analysis), not an observation`
- A WHAT LIVES HERE click reads the value under the point from the frame on show, e.g.
  `🦐 Surface zooplankton carbon (model): 0.54 mmol C/m³ · 2026-10-07`; land reads no data; the clamped ends read
  `≤ 0.05 mmol C/m³` / `≥ 5 mmol C/m³`.
- Credit: the existing `cmems` credit, extended to name zooplankton.

## Source (read live 2026-10-07, copernicusmarine 2.4.1)

- Product GLOBAL_ANALYSISFORECAST_BGC_001_028 (doi 10.48670/moi-00015, the product of `cmems-o2` / `cmems-ph`),
  dataset `cmems_mod_glo_bgc-plankton_anfc_0.25deg_P1D-m`, variable `zooc` ("Total Zooplankton", mmol m-3,
  `mole_concentration_of_zooplankton_expressed_as_carbon_in_sea_water`, valid_min 0, valid_max 5), 1440×681
  (lat -80..90, lon -180..179.75, cell centres), time 2023-11-29 → 2026-10-16 (forecast past today is skipped).
- 2026-10-07 surface: 30.4% NaN (land); percentiles 0.1/1/5/50/95/99/99.9 = 0.052/0.069/0.094/0.54/2.26/3.14/4.53;
  max 5.0 (= valid_max; 317 ocean cells sit exactly at 5.0, so the model output is capped there: they read `≥ 5`).
- What the number is (PUM CMEMS-GLO-PUM-001-028): "This product is based on the PISCES biogeochemical model. It is
  forced offline at a daily frequency by GLOBAL_ANALYSISFORECAST_PHY_001_024 coarsened at 1/4 degree, with SEEK-based
  Data Assimilation of OCEANCOLOUR_GLO_BGC_L4_NRT_009_102." Only satellite chlorophyll is assimilated; zooplankton is
  not observed. QUID §IV.14: total zooplankton carbon "is calculated as the sum of the microzooplankton and the
  mesozooplankton concentrations calculated by the model"; against MAREDAT the model "underestimates high biomass
  values and overestimates low values". Hence the legend's "model value, not an observation".

## Ramp: log, 0.05 to 5 mmol C/m³

The field spans ~45× between its 1st and 99th percentiles; a linear ramp would spend most of its colours on the top
5% and paint the gyres one colour. Log10 interpolation between `min` and `max`; 0.05–5 is two decades, clips 0.05% of
ocean cells at the low end and none at the top (5 is the variable's valid_max), and puts the ramp's middle colour at
0.5, next to the median 0.54. Stops: viridis at 0, ¼, ½, ¾, 1 (colour-blind safe, distinct from the chlorophyll greens).

The manifest already has a log flag: `chlor-a`'s ramp carries `"log": true` and `legendItems` labels its middle
swatch with the geometric mean. The new ramp uses that same key (one spelling, which the browser already reads), and
`ramp_rgba` learns it. A ramp without `log` renders byte-identically to today.

## Licence (read live 2026-10-07, marine.copernicus.eu "service commitments and licence")

Art. 2.2(b): licensees may "modify, adapt, develop, create and distribute Value Added Products or Derivative Work
from Copernicus Marine Service Products for any purpose". Art. 2.4(a), derivative works must show: "Generated using
E.U. Copernicus Marine Service Information; insert DOIs links here". The drape is a derivative work; the `cmems`
credit already carries that sentence and the DOI link 10.48670/moi-00015, which is this product's DOI too.

## Design

- `pipeline/rasters.json`: a `cmems-zooc` row modelled on `cmems-o2` (`cmems` block, `ramp` with `log: true`).
  `fetch_cmems` and the daily raster cron need nothing new.
- `pipeline/raster.py` `ramp_rgba`: when `ramp.log`, interpolate on log10(value) between log10(min) and log10(max);
  values ≤ 0 clamp to the low end; NaN stays transparent.
- `src/data/rasterDrape.js`: pure `rampValue(t, ramp)` (linear or log) and `rampPosition(rgb, stops)` (where an RGB
  colour lies on the ramp's polyline; a colour off the ramp is named, never snapped). A drape created with
  `readout: true` gets `readoutAt(lat, lon)`, which decodes the shown frame's own PNG bytes (`decodePng`), takes the
  pixel under the point in the drape's own geometry (`bounds`), and inverts it through the ramp. Only `cmems-zooc`
  opts in: its PNG is drawn through the manifest ramp by `ramp_rgba`. ERDDAP-drawn ramps are not.
  The log legend's middle label comes from `rampValue` at the middle swatch, printed to 2 significant figures.
- Registration as for `cmems-ph`: layerState token `zc` (registry count 63 → 64), main.js register + drape list +
  observed-time list + readout list, `dataCredits` `cmems`, DATA_SOURCES.md, pipeline/README.md.

## Acceptance

- `python3 -m pytest -q pipeline` and `npm test` exit 0; the new tests seen to fail before the code.
- Real run: `python3 -m pipeline.raster --out public/data --only cmems-zooc` writes `rasters/cmems-zooc.png` (1440×681)
  and its manifest entry. Independent route: three or more cells (Peru or Benguela upwelling, a subtropical gyre, a
  high-latitude cell) read straight from the dataset with xarray agree with the PNG's colour inverted through the ramp.
- `python3 -B scripts/qa_cmems_zooc_truth.py public/data > truth.json` (the independent route: raw values with xarray,
  the PNG colour's value band from its own log rendering), then
  `node scripts/qa-cmems-zooc.mjs --truth truth.json --url <local vite preview>` exit 0: legend text exactly as above,
  swatch labels, credit, share token `zc` and its round trip, on the time bar, drawn, the readout at each cell inside
  the PNG colour's band at 2 significant figures and within 5% of the raw value (`≥ 5` at the capped top), a land cell
  reads no data, no console errors. Negative control: the same QA with every raw value ×1.2 fails.
- `mutate-run` on the log ramp, `rampValue`, `rampPosition` and the readout: killed/total reported.

## Constraints

- Products without `log` render byte-identically (a pytest pins it). No other layer's legend or readout changes.
- The drape uses the same `bounds` convention as `cmems-o2` / `cmems-ph` (cell centres -80..90, -180..180 taken as
  image edges), so the readout reads what is drawn. That convention draws each cell up to ~0.27° off near 80°S;
  fixing it for the siblings is out of scope here and reported.
- Out of scope (decision 5): micronekton, plankton size classes, phytoplankton types (separate PR), uncertainty.
- Budget: 0.84 MB a day (2026-10-07) × 30 archived days ≈ 25 MB.
