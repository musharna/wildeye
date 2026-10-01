# Surface water (JRC) — design (2026-10-01)

Step 5a of the bio-interpolation wave (grill: `grill_wildeye_bio_interpolation_2026-09-29`, Q8: Tier A adds one PR
each, JRC water first; survey `wildeye_global_bio_coverage_survey_2026-09-22`). Defaults A1–A5 stated to the
maintainer on "go"; veto at the draft PR.

## Outcome

Switch on **Surface water (JRC, 1984–2021)**. The globe is drawn with JRC's own water-occurrence map: water seen in
few months is faint, permanent water (lakes, the open sea) solid blue. A WHAT LIVES HERE click reads the spot:
"Water in 37% of months · 1984–2021", "No surface water seen · 1984–2021", or "outside the map" beyond the data.

## Source (probed 2026-10-01)

- Tiles: `https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png`, keyless,
  `access-control-allow-origin: *`, 256 px, served to z13 (z14 is 404 over land).
- Licence (download page, read 2026-10-01): "provided free of charge, without restriction of use"; map credit
  "Source: EC JRC/Google". Cite Pekel, Cottam, Gorelick & Belward 2016, Nature 540:418–422,
  doi:10.1038/nature20584 (CrossRef-checked 2026-10-01).
- Coverage: tiles beyond about 78°N and 59°S are 404. Inside it, dry land is a transparent pixel and the open sea
  is opaque blue (100%).
- Colour: one colour per occurrence percent k = 1–100. 14 places at z13 (456,433 water pixels) hold exactly 100
  distinct colours; `((25500−255k)//100, 0, 255k//100, round(2.55k))` gives 99 of them, and k = 80 is
  `(50,0,204,204)` (the encoder's own float rounding). The readout is an exact lookup in that table; any other
  colour is named as unrecognised, never snapped.

## Design

- **A1** occurrence only. Change and transitions add a second (green/red) colour language; not now.
- **A2** a fixed product (1984–2021): not on the time bar. A drape, so it joins drape exclusivity and compare.
- **A3** readout from the raw z13 tile pixel, through the shared tile reader; a 404 there is "outside the map".
- **A4** credit in `dataCredits.js` and a `DATA_SOURCES.md` row; share token `sw`.
- Not in scope: other JRC products, seasonality, a legend beyond a short ramp.

## Acceptance

- `npm test` green; new tests seen to fail first (decode table, readout statuses including 404, layer lifecycle).
- `node scripts/qa-surface-water.mjs` against a local build exits 0. It checks that the layer draws (pixel
  read-back) and reads open Lake Victoria at 97–99%, Tonle Sap's flood plain at 83%, the open Atlantic at 100%, a Sahara control as no water and
  80°N as outside (each the centre of a 5×5 block decoded by an independent Python probe).
  Every water pixel of the real z13 tiles it reads decodes (0 unrecognised). No page errors.
- Perf gates unchanged, or a measured, explained acceptance.
