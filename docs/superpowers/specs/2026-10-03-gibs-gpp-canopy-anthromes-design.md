# Plant productivity, canopy height and anthropogenic biomes from NASA GIBS (2026-10-03)

Wave 2, PR 1 (grill `grill_wildeye_wave2_2026-10-03`). Three more NASA GIBS layers, drawn straight from GIBS like the
seven already on the site (`src/data/gibsLayer.js`, `pipeline/gibs.py`). No new code path: each is a `LAYERS` entry,
a `createGibsLayer` export, a share token and its credits.

## Outcome

- **Plant productivity (MODIS GPP, 8-day)** (`gibs-gpp`, token `gp`): GIBS `MODIS_Terra_L4_Gross_Primary_Productivity_8Day`
  (MOD17A2H v061, Web Mercator to level 8, 8-day composites 2000-01-01 on). Follows the time bar. A click reads the
  composite's value, e.g. `0.0587 kgC/m²` (carbon fixed over the 8 days: CMR calls MOD17A2H "a cumulative 8-day
  composite"). GIBS's classification map (urban, wetland, snow/ice, barren, water, fill, not computed) is drawn
  transparent and reads no data.
- **Canopy height (GEDI, 2019–2023)** (`gibs-canopy`, token `ch`): GIBS `GEDI_ISS_L3_Canopy_Height_Mean_RH100_201904-202303`
  (GEDI L3 v2 mean RH100 per 1 km cell, 52°S–52°N). A composite, so `timeless` like forest biomass: it ignores the bar
  and declares no extent. Reads e.g. `22.8 m`; the top bin `≥ 45.0 m`; black is no data.
- **Anthropogenic biomes (SEDAC, 2001–2006)** (`gibs-anthromes`, token `ab`): GIBS `Anthropogenic_Biomes_of_the_World_2001-2006`
  (Ellis & Ramankutty v1, 21 classes on a 0.0833° grid). Undated in GIBS, like the SEDAC richness grids, so `asOf`
  "2001–2006" (CMR temporal extent 2001-01-01 to 2006-12-31). Reads the class label, e.g. `Remote forest`; the empty
  ocean tile is opaque black and reads no data.

## What the live data showed (probes 2026-10-03, Python + Pillow on GIBS tiles, independent of the pipeline)

- 3°S 60°W, the point the SEDAC QA uses, is Manaus: GPP reads its transparent "Urban" class and anthromes "Urban".
  The Amazon known answers use 5°S 65°W instead.
- Canopy height reads 3.5–4.0 m over the Sahara and Egyptian desert at every point probed (23°N 10°E, 25°N 30°E,
  20°N 5°E). RH100 is the waveform's top above ground; bare ground does not read 0. The legend says so.
- Canopy height has data at 51°N 120°W and none at 53°N or 53°S (CMR: "within -52 and 52 degrees latitude").
- GPP's 0.0005-wide bins print at 4 decimals; every midpoint stays inside its own bin (unit test over all 240).

## Licences (read live 2026-10-03)

- GPP and canopy height: NASA Earth science data policy (CMR `LicenseURL` for both collections); GIBS asks for its
  acknowledgement, already in the `nasa-gibs` credit ("NASA promotes full and open sharing of data", re-read).
- Anthromes: CMR UseConstraints "free to use, copy, distribute, transmit, and adapt the work for commercial and
  non-commercial purposes, without restriction, as long as clear attribution of the source is provided".
- Citations, creators as registered at DataCite: Running, Mu, Zhao 2021, doi:10.5067/MODIS/MOD17A2H.061; Dubayah,
  Luthcke, Sabaka et al. 2021, doi:10.3334/ORNLDAAC/1952; Ellis and Ramankutty 2008, doi:10.7927/H4H12ZXD. The GIBS
  layer metadata names these collections as the layers' sources.

Tiles load from GIBS; nothing is re-hosted, so the Pages budget is unchanged.

## Acceptance

- `npm test` and `pytest pipeline/tests` exit 0; the registry and `LAYERS` tests seen to fail first.
- `python3 -m pipeline.gibs` against live GIBS writes the three entries and leaves the seven existing ones
  byte-identical (compared against the deployed `gibs.json`).
- `node scripts/qa-gibs.mjs` (real browser, swiftshader) draws all ten layers with tiles on the right date, reads the
  known answers above (GPP pinned to 2024-07-01 → the 2024-06-25 composite, since the latest changes every 8 days),
  and checks canopy height alone leaves the bar with no domain while GPP alone spans 2000 on.

## Constraints

No change to `createGibsLayer`, the readout decoder or the seven existing entries. No re-hosting. Share tokens `gp`,
`ch`, `ab` are unused today. Out of scope: GPP's classification colours as readout labels (they read no data, as
EVI's do), NPP, canopy height variants (standard deviation, other RH metrics).
