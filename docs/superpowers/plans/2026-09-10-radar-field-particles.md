# Radar Field + Particles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drape a rain-masked biology reflectivity image under each radar and animate 4,000 ensemble "contacts" moving at measured u/v.

**Architecture:** Pipeline gains `ppi.py` (Py-ART sweep-0 → masked 0.01° grid → PNG + bounds) and `field.py` (composite 0.02° domain PNG + JSON with per-site u/v). `birds.js` adds per-site `SingleTileImageryProvider` layers and a `PointPrimitiveCollection` particle system advanced on `clock.onTick` under a render-governor hold. Pure helpers in `src/data/birdsField.js` are unit-tested.

**Tech Stack:** Python: arm_pyart 2.2.5, numpy, Pillow. JS: CesiumJS, node:test.

**Spec:** `docs/superpowers/specs/2026-09-10-radar-field-particles-design.md`

## Global Constraints
- Biology mask: RHOHV < 0.95, −10 ≤ dBZ < 35, 5 km ≤ range ≤ 150 km. Grid 0.01° per site over ±1.6°; composite 0.02°.
- Intensity byte = clip((dBZ + 10) / 45 × 255).
- Particle count 4000, life 90 s, IDW power 2 nearest 3 sites.
- Governor owner id `'birds'`; hold on enable, release on disable/destroy.
- Fail loud per site; last-good PNG/bounds kept.

---

### Task 1: `pipeline/ppi.py` rasterizer (+ reducer u/v)
**Files:** Create `pipeline/ppi.py`; Modify `pipeline/vol2bird.py` (`reduce_profile` adds `u_ms`,`v_ms`); Test `pipeline/tests/test_ppi.py`, extend `test_vol2bird.py`.
**Produces:** `bio_grid(radar) -> (grid uint8 HxW, bounds dict)`; `write_ppi_png(grid, path)`; `ppi_for_volume(volume: Path, out_png: Path) -> bounds`.
Steps: failing tests (synthetic radar via `pyart.testing.make_empty_ppi_radar(ngates=600, rays_per_sweep=360, nsweeps=1)` with reflectivity 20 dBZ everywhere, RHOHV 0.99 for azimuth<90 else 0.90, range gates 0.25 km; assert rain quadrant cells are 0 and bird quadrant cells >0 in the SAME test; grid shape (320,320); bounds ±1.6° around radar) → run fail → implement (gate lon/lat from `radar.gate_longitude['data']`, `gate_latitude`; bin with `np.maximum.at`) → pass → real-exec on cached KOKX file, PNG >1 KB → commit.

### Task 2: `pipeline/field.py` composite + JSON, wire into `build_birds.py`
**Files:** Create `pipeline/field.py`; Modify `pipeline/build_birds.py`; Test `pipeline/tests/test_field.py`.
**Produces:** `composite(sites: list[{grid, bounds}], res=0.02) -> (grid, bounds)`; `write_field(out_dir, features, ppi_meta) -> dict`.
Steps: failing test (two overlapping grids → max, bounds = union) → implement → build_birds: `process_site` also calls `ppi_for_volume` and returns `(feature, ppi_meta)`; after the loop write `birds_field.json` + `.png`; keep last-good ppi meta from previous json for failed sites → run 20 sites, assert all PNGs exist → commit.

### Task 3: `src/data/birdsField.js` pure helpers
**Files:** Create `src/data/birdsField.js`, `src/data/birdsField.test.mjs`.
**Produces:** `buildSpawnCdf(rgba, w, h) -> {cdf: Float32Array, total}`; `sampleCell(cdf, u01) -> index` (binary search); `idwVelocity(sites, lon, lat, k=3, p=2) -> {u,v}`; `stepParticle(p, dt, bounds) -> p` where p={lon,lat,u,v,age}; deg/s = u/(111320·cos lat), v/110540.
Tests: CDF total equals sum of R channel; sampling with u=0.999 never returns a zero-weight cell; IDW at a site's exact position returns its u,v; step with u=+10 increases lon; step outside bounds sets `dead`.

### Task 4: `birds.js` drape + particles
**Files:** Modify `src/data/birds.js`.
- On `update()`: fetch `data/birds_field.json`; for each site with `png`, create `new Cesium.ImageryLayer(new Cesium.SingleTileImageryProvider({url, rectangle: Cesium.Rectangle.fromDegrees(w,s,e,n), tileWidth, tileHeight}))`, alpha 0.7, push to `_imagery[]`, `viewer.imageryLayers.add`. Remove prior ones first. (SingleTileImageryProvider in Cesium ≥1.104 needs tileWidth/tileHeight or uses `fromUrl`; use `Cesium.SingleTileImageryProvider.fromUrl(url,{rectangle})` async.)
- Load `birds_field.png` via `Image` + offscreen canvas → `buildSpawnCdf`; store `_field = {cdf,total,w,h,bounds,sites}`; (re)seed 4000 particles.
- `_points = new Cesium.PointPrimitiveCollection()` added to `viewer.scene.primitives` in init; each particle → point with `id: 'birds-particle:'+i`, pixelSize 3, color headingColor(heading).
- `enable`: `holdContinuousRender('birds')`, add `viewer.clock.onTick` listener that advances all particles by real dt (`Cesium.JulianDate.secondsDifference`) and respawns dead/aged ones; `disable/destroy`: remove listener, `releaseContinuousRender('birds')`, hide/destroy points and imagery.
- Click: `ScreenSpaceEventHandler` LEFT_CLICK; if picked id starts with `birds-particle:` set `viewer.selectedEntity` to a transient entity (in `_dataSource`) positioned at the particle with description "Ensemble contact — represents ~N birds …". N = cellDensity × cellAreaKm2 × 1 km / particlesPerCell where particlesPerCell = 4000 × (cellWeight/total).
- Node contract test extended: layer still exposes the same functions; `getStats()` includes `particles`.
Real-exec: Node live-run script from M1 extended to check `_field.sites.length===20`. Visual: user.

### Task 5: docs + commit
Update `pipeline/README.md` (new outputs, wall time), spec status line, memory.
