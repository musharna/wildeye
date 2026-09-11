# wildeye M2+M3 — Radar biology image and particle flow

Date: 2026-09-10. Status: BUILT 2026-09-10 (M2 drape + M3 particles); visual check by user. Follows M1.

## Goal
Localize migrating birds inside each radar's footprint (M2) and animate the
flow as an ensemble of "contacts" that move at measured speed and heading (M3),
so the layer reads like the flights layer while staying honest that radar
resolves crowds, not individuals.

## Pipeline additions
- `pipeline/ppi.py`: from the same Level II volume (Py-ART
  `read_nexrad_archive`), take the lowest reflectivity sweep (sweep 0, 0.5°).
  Biology mask: RHOHV < 0.95, −10 ≤ dBZ < 35, 5 km ≤ range ≤ 150 km.
  Bin gate centres onto a 0.01° lon/lat grid over the radar ±1.6°, max
  reflectivity per cell, map −10..35 dBZ to 0..255. Write
  `public/data/birds_ppi/<SITE>.png` (RGBA viridis-like ramp, alpha 0 where
  masked) and return bounds {west,south,east,north}.
- `pipeline/field.py`: composite all site grids onto one 0.02° domain grid
  (union of bounds), max per cell, write `public/data/birds_field.png`
  (greyscale, alpha 0 where empty) and `public/data/birds_field.json`:
  `{generated_at, bounds, width, height, sites:[{site, lat, lon, u_ms, v_ms,
  speed_ms, heading_deg, density_birds_km3, peak_altitude_m, png, bounds}]}`.
- `pipeline/vol2bird.py` reducer gains `u_ms`, `v_ms` (density-weighted means
  of vol2bird u, v over 0–3000 m).
- `build_birds.py` calls ppi per site inside `process_site` (same download,
  ~+3 s/site) and field once at the end; failures per site stay loud and keep
  last-good PNG/bounds.

## Globe layer (`src/data/birds.js` extended, still one layer `birds`)
- Drape: one `Cesium.SingleTileImageryProvider` imagery layer per site from
  `birds_ppi/<SITE>.png` with its bounds, alpha 0.7, added/removed with the
  layer and replaced on each update.
- Particles: `Cesium.PointPrimitiveCollection`, N = 4000. Spawn positions are
  sampled from `birds_field.png` intensity (read once per update via an
  offscreen canvas into a Float32 CDF). Each particle's velocity is the
  inverse-distance-weighted (power 2, nearest 3 sites) u,v of the sites, in
  m/s, converted to deg/s at its latitude. Life 90 s then respawn. Advance on
  `viewer.clock.onTick` with real dt; hold the render governor continuous
  while enabled (same call flights uses). Point size 3 px, colour = heading
  hue (same `headingColor`), alpha 0.85. Each particle's tooltip on pick:
  "Ensemble contact — represents ~N birds; local density D birds/km³; heading
  H°; ground speed S m/s; from radar SITE". N = density × (domain cell area ×
  1 km depth) / particles-in-cell, shown as an approximation.
- Columns from M1 stay.
- Time: pipeline unchanged at 10 min cadence; client animation is continuous.

## Pure helpers (exported, unit-tested)
- `buildSpawnCdf(Uint8ClampedArray rgba, w, h) -> Float32Array` cumulative
  weights; `sampleCell(cdf, u01) -> index`.
- `idwVelocity(sites, lon, lat) -> {u, v}`.
- `stepParticle(p, dtSec) -> p` (deg/s at latitude; wraps nothing, marks
  `dead` outside bounds).

## Testing
- pytest: rasterizer on a `pyart.testing.make_empty_ppi_radar` with injected
  reflectivity/RHOHV where one quadrant is "rain" (RHOHV 0.99) and one is
  "birds" (RHOHV 0.9): rain quadrant masked, bird quadrant present, both
  asserted in the same test. Composite: two overlapping grids → max.
- Real-execution: full 20-site run, every `birds_ppi/*.png` exists and is
  non-trivial (>1 KB), `birds_field.png` exists, wall time recorded.
- node:test: spawn CDF sums to total intensity and never samples a zero cell;
  IDW at a site returns that site's u,v; step moves east for +u.
- Visual: user opens the app; I cannot render WebGL headless here.

## Out of scope
Dealiasing or per-gate 2D velocity; species; Movebank (M4); non-CONUS.
