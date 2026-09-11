import * as Cesium from 'cesium';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { buildSpawnCdf, sampleCell, idwVelocity, stepParticle, seededRandom, frameSeed } from './birdsField.js';

/**
 * Nocturnal bird migration density per NEXRAD radar, produced by
 * pipeline/build_birds.py (vol2bird on Level II volumes). One column per
 * radar: height ∝ density, hue = heading. Static geometry between polls.
 */
const DATA_URL = 'data/birds.geojson';
const FIELD_URL = 'data/birds_field.json';
const MANIFEST_URL = 'data/birds_archive/manifest.json';
const SEEK_DEBOUNCE_MS = 150;

/** Newest archive frame id ('YYYY-MM-DDTHH') at or before an ISO instant (pure); null when none. */
export function frameIdAtOrBefore(ids, iso) {
  const t = Date.parse(iso);
  if (!Array.isArray(ids) || !Number.isFinite(t)) return null;
  let best = null;
  for (const id of ids) { const ft = Date.parse(`${id}:00:00Z`); if (Number.isFinite(ft) && ft <= t && (best === null || ft > Date.parse(`${best}:00:00Z`))) best = id; }
  return best;
}
const PARTICLE_COUNT = 1500;
const PARTICLE_LIFE_S = 90;
const PARTICLE_ALT_M = 600;
const PARTICLE_PX = 2;
const DRAPE_ALPHA = 0.35;
// Camera-height ramp for the drape: fully visible below FADE_NEAR_M, gone above FADE_FAR_M.
const FADE_NEAR_M = 800_000;
const FADE_FAR_M = 2_000_000;
const MAX_COLUMN_M = 120000;
const BASE_RADIUS_M = 12000;

export function birdColumn(density) {
  const d = Number(density);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.min(MAX_COLUMN_M, 5000 * Math.log1p(d));
}

/** Drape opacity multiplier for a camera height in metres: 1 near, 0 far, linear between. */
export function drapeFade(heightM) {
  const h = Number(heightM);
  if (!Number.isFinite(h) || h <= FADE_NEAR_M) return 1;
  if (h >= FADE_FAR_M) return 0;
  return 1 - (h - FADE_NEAR_M) / (FADE_FAR_M - FADE_NEAR_M);
}

const DEFAULT_PARAMS = Object.freeze({ columns: false, drape: true, particles: true });

export function headingColor(deg) {
  const h = Number(deg);
  if (!Number.isFinite(h)) return Cesium.Color.GRAY;
  return Cesium.Color.fromHsl((((h % 360) + 360) % 360) / 360, 0.9, 0.55);
}

/** On-map legend: colour = heading (hue wheel, shared by columns and flow), height = log density. */
export function birdsLegend(params = DEFAULT_PARAMS) {
  const items = [];
  if (params.columns || params.particles) {
    for (const [label, deg] of [['→ N', 0], ['→ E', 90], ['→ S', 180], ['→ W', 270]]) {
      items.push({ label, color: headingColor(deg).toCssColorString(), count: null });
    }
  }
  if (params.columns) items.push({ label: 'column height = log(birds/km³), 5 km per e-fold, faded = stale scan', color: 'transparent', count: null });
  if (params.drape) items.push({ label: 'radar: probable biological echo (rain masked)', color: 'transparent', count: null });
  return items;
}

export function mapBirdRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  return {
    id: text(raw?.site) || `RADAR-${String(index).padStart(4, '0')}`,
    name: text(raw?.name),
    densityBirdsKm3: num(raw?.density_birds_km3),
    headingDeg: num(raw?.heading_deg),
    speedMs: num(raw?.speed_ms),
    peakAltitudeM: num(raw?.peak_altitude_m),
    scanTime: text(raw?.scan_time),
    stale: Boolean(raw?.stale),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
  };
}

/** Build the Cesium entity options for one radar column (shared with the Aloft layer). */
export function columnEntity(f, idPrefix = 'birds', describeFn = describe) {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties || {};
  const h = birdColumn(p.density_birds_km3);
  const color = headingColor(p.heading_deg).withAlpha(p.stale ? 0.25 : 0.6);
  return {
    id: `${idPrefix}:${p.site}`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(h, 500) / 2),
    cylinder: {
      length: Math.max(h, 500),
      topRadius: BASE_RADIUS_M,
      bottomRadius: BASE_RADIUS_M,
      material: new Cesium.ColorMaterialProperty(color),
      outline: true,
      outlineColor: color.withAlpha(0.9),
    },
    description: describeFn(p, h),
    properties: { ...p, lat, lon },
  };
}

export function describe(p, h) {
  const head = `<b>${p.name ?? p.site}</b> (${p.site})<br>`;
  const body = h > 0
    ? `${Number(p.density_birds_km3).toFixed(1)} birds/km³, heading ${Math.round(p.heading_deg)}°, ` +
      `${Number(p.speed_ms ?? 0).toFixed(0)} m/s, peak ${p.peak_altitude_m} m`
    : 'Quiet — no biological echo (daytime or clear)';
  return `${head}${body}<br>scan ${p.scan_time}${p.stale ? ' (stale, last good)' : ''}`;
}

export function createBirdsLayer() {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _generatedAt = null;
  let _viewer = null;
  let _imagery = [];          // Cesium.ImageryLayer per radar (drape)
  let _points = null;         // PointPrimitiveCollection (particles)
  let _particles = [];        // {lon,lat,u,v,age,dead,cell}
  let _field = null;          // {cdf,total,w,h,bounds,sites,cellDeg}
  let _tickRemover = null;
  let _lastTick = null;
  let _clickHandler = null;
  let _enabled = false;
  let _params = { ...DEFAULT_PARAMS };
  let _preRenderRemover = null;
  let _fade = 1;
  let _lastWallMs = null;
  let _rowControlsListener = null;
  let _mode = 'live';            // 'live' | 'replay'
  let _rng = Math.random;        // seeded per frame in replay
  let _gen = 0;                  // generation token: stale async loads are dropped
  let _manifest = null;          // {frames: {id: {...}}, ids: [sorted]}
  let _replay = null;            // {index, frameId} while in replay
  let _seekTimer = null;

  function applyVisibility() {
    if (_dataSource) _dataSource.show = _enabled && _params.columns;
    for (const il of _imagery) il.show = _enabled && _params.drape;
    if (_points) _points.show = _enabled && _params.particles;
  }

  function onPreRender() {
    if (!_viewer || !_params.drape || !_imagery.length) return;
    const h = _viewer.camera?.positionCartographic?.height;
    const f = drapeFade(h);
    if (Math.abs(f - _fade) < 0.01) return;
    _fade = f;
    for (const il of _imagery) il.alpha = DRAPE_ALPHA * f;
  }

  function removeImagery() {
    if (!_viewer) return;
    for (const il of _imagery) _viewer.imageryLayers.remove(il, true);
    _imagery = [];
  }

  /**
   * Replace the drape set. New providers are fully loaded BEFORE the old
   * layers are removed (no flicker), and a generation token drops any load
   * that finished after a newer request started (no stale overwrite).
   * @param {Array<{url:string,bounds:object,bust?:boolean}>} items
   */
  async function setDrapes(items, gen) {
    const layers = await Promise.all(items.filter((s) => s.url && s.bounds).map(async (s) => {
      const b = s.bounds;
      const url = s.bust ? `${s.url}?t=${Date.now()}` : s.url;
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(url, {
        rectangle: Cesium.Rectangle.fromDegrees(b.west, b.south, b.east, b.north),
      });
      const il = new Cesium.ImageryLayer(provider, { alpha: DRAPE_ALPHA * _fade });
      il.show = _enabled && _params.drape;
      return il;
    }));
    if (gen !== _gen || !_viewer) return; // superseded while loading
    removeImagery();
    for (const il of layers) { _viewer.imageryLayers.add(il); _imagery.push(il); }
  }

  function loadFieldImage(url, bust = true) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve({ rgba: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height });
      };
      img.onerror = () => reject(new Error(`field image failed: ${url}`));
      img.src = bust ? `${url}?t=${Date.now()}` : url;
    });
  }

  function spawn(i) {
    const f = _field;
    const cell = sampleCell(f.cdf, _rng());
    const row = Math.floor(cell / f.w), col = cell % f.w;
    const lon = f.bounds.west + (col + _rng()) * f.cellLon;
    const lat = f.bounds.north - (row + _rng()) * f.cellLat;
    const { u, v } = idwVelocity(f.sites, lon, lat);
    const p = { lon, lat, u, v, age: _rng() * PARTICLE_LIFE_S * 0.5, dead: false, cell };
    _particles[i] = p;
    const pt = _points.get(i);
    pt.position = Cesium.Cartesian3.fromDegrees(lon, lat, PARTICLE_ALT_M);
    pt.color = headingColor((Math.atan2(u, v) * 180) / Math.PI).withAlpha(0.85);
    pt.show = true;
  }

  function reseed() {
    if (!_points || !_field || _field.total <= 0) return;
    while (_points.length < PARTICLE_COUNT) {
      _points.add({ id: `birds-particle:${_points.length}`, pixelSize: PARTICLE_PX, show: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY });
    }
    for (let i = 0; i < PARTICLE_COUNT; i++) spawn(i);
  }

  function onTick() {
    // Wall-clock dt: the animation is illustrative and must not follow the
    // Cesium clock (a replay slider or rewind would otherwise advect forward).
    if (!_enabled || !_params.particles || !_field || !_points || _field.total <= 0) return;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = _lastWallMs === null ? 0 : Math.min(2, (nowMs - _lastWallMs) / 1000);
    _lastWallMs = nowMs;
    if (dt <= 0) return;
    for (let i = 0; i < _particles.length; i++) {
      const p = stepParticle(_particles[i], dt, _field.bounds, PARTICLE_LIFE_S);
      if (p.dead) { spawn(i); continue; }
      _particles[i] = p;
      _points.get(i).position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, PARTICLE_ALT_M);
    }
  }

  function describeParticle(i) {
    const p = _particles[i]; const f = _field;
    const weight = f.cdf[p.cell] - (p.cell > 0 ? f.cdf[p.cell - 1] : 0);
    const nearest = f.sites.filter((s) => Number.isFinite(s.density_birds_km3))
      .sort((a, b) => Math.hypot(a.lon - p.lon, a.lat - p.lat) - Math.hypot(b.lon - p.lon, b.lat - p.lat))[0];
    const dens = nearest ? nearest.density_birds_km3 * (weight / 255) : 0;
    const speed = Math.hypot(p.u, p.v);
    const heading = ((Math.atan2(p.u, p.v) * 180) / Math.PI + 360) % 360;
    return `<b>Ensemble contact</b> (illustrative)<br>` +
      `probable biological echo · local density ≈ ${dens.toFixed(1)} birds/km³ at the radar profile scale<br>` +
      `heading ${Math.round(heading)}° · ground speed ${speed.toFixed(0)} m/s<br>` +
      `nearest radar ${nearest ? `${nearest.site} (${nearest.name})` : 'n/a'} · scan ${nearest?.scan_time ?? 'n/a'}<br>` +
      `<i>Weather radar resolves crowds, not individuals. Dots are drawn in proportion to echo strength and move at the radar-measured velocity; the count of birds per dot is not calibrated.</i>`;
  }

  function installClick(viewer) {
    if (_clickHandler) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      const picked = viewer.scene.pick(click.position);
      const id = picked && (typeof picked.id === 'string' ? picked.id : picked.primitive?.id);
      if (typeof id !== 'string' || !id.startsWith('birds-particle:')) return;
      const i = Number(id.slice('birds-particle:'.length));
      const p = _particles[i]; if (!p) return;
      const eid = 'birds:contact';
      _dataSource.entities.removeById(eid);
      const ent = _dataSource.entities.add({
        id: eid, name: 'Ensemble contact',
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, PARTICLE_ALT_M),
        point: { pixelSize: 8, color: Cesium.Color.WHITE.withAlpha(0.9) },
        description: describeParticle(i),
      });
      viewer.selectedEntity = ent;
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: 'birds',
    name: 'Bird migration (radar)',
    icon: '🐦',
    source: 'NEXRAD via vol2bird',
    updateInterval: 600000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('birds');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      if (viewer.scene?.primitives) {
        _points = new Cesium.PointPrimitiveCollection();
        _points.show = false;
        viewer.scene.primitives.add(_points);
      }
      if (viewer.scene?.canvas) installClick(viewer);
      _count = 0; _lastUpdate = null; _lastError = null; _generatedAt = null;
      console.log('[Data:Birds] Initialized');
    },
    enable(viewer) {
      _enabled = true;
      applyVisibility();
      if (viewer?.clock && !_tickRemover) {
        _lastWallMs = null;
        _tickRemover = viewer.clock.onTick.addEventListener(onTick);
        holdContinuousRender('birds'); // per-frame particle animator
      }
      if (viewer?.scene?.preRender && !_preRenderRemover) {
        _preRenderRemover = viewer.scene.preRender.addEventListener(onPreRender);
      }
      if (_manifest === null && typeof document !== 'undefined') this._loadManifest();
    },
    disable() {
      _enabled = false;
      applyVisibility();
      if (_mode === 'replay') { _mode = 'live'; _rng = Math.random; ++_gen; _replay = null; }
      if (_tickRemover) { _tickRemover(); _tickRemover = null; }
      if (_preRenderRemover) { _preRenderRemover(); _preRenderRemover = null; }
      releaseContinuousRender('birds');
    },

    /** Component toggles (columns / drape / particles); share-link persisted via layerState options. */
    setParams(params = {}) {
      let changed = false;
      for (const k of Object.keys(DEFAULT_PARAMS)) {
        if (typeof params[k] === 'boolean' && params[k] !== _params[k]) { _params[k] = params[k]; changed = true; }
      }
      if (changed) { applyVisibility(); _rowControlsListener?.(); }
      return changed;
    },
    getParams() { return { ..._params }; },
    getRowControls() {
      const chip = (id, label, title) => ({ id, label, active: _params[id], state: _params[id] ? 'active' : 'idle',
        title: `${_params[id] ? 'Hide' : 'Show'} ${title}`, params: { [id]: !_params[id] } });
      return {
        chips: [
          chip('columns', 'COLUMNS', 'per-radar density columns'),
          chip('drape', 'RADAR', 'the probable-biological-echo radar image'),
          chip('particles', 'FLOW', 'the illustrative migration flow particles'),
        ],
        legend: birdsLegend(_params),
      };
    },
    setRowControlsListener(listener) { _rowControlsListener = typeof listener === 'function' ? listener : null; },

    /** Rebuild the per-radar columns from a FeatureCollection. Returns the count. */
    _renderColumns(gj) {
        _dataSource.entities.removeAll();
        let count = 0;
        for (const f of gj.features) {
          count++;
          _dataSource.entities.add(columnEntity(f, 'birds'));
        }
        return count;
    },

    async update() {
      if (_mode === 'replay') return true; // the 10-min poll must not overwrite a selected frame
      try {
        const res = await fetch(`${DATA_URL}?t=${Date.now()}`);
        if (!res.ok) { _lastError = `birds.geojson HTTP ${res.status}`; return false; }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) { _lastError = 'Malformed birds.geojson'; return false; }
        _count = this._renderColumns(gj);
        _generatedAt = gj.generated_at ?? null;
        await this._updateField();
        if (_manifest !== null) await this._loadManifest(true); // pick up frames the cron added since load
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Birds] Updated: ${_count} radars, generated ${_generatedAt}`);
        return true;
      } catch (e) {
        console.warn('[Data:Birds] Fetch error:', e);
        _lastError = 'birds.geojson network error';
        return false;
      }
    },

    /** Replay: show one archived hourly frame. Deterministic particle seed per frame. */
    async _showFrame(id) {
      if (!_manifest || !_manifest.frames[id] || !_viewer) return;
      const gen = ++_gen;
      const m = _manifest.frames[id];
      const [gjRes, fjRes] = await Promise.all([fetch(`${m.dir}/birds.geojson`), fetch(`${m.dir}/field.json`)]);
      if (gen !== _gen) return;
      if (!gjRes.ok || !fjRes.ok) { _lastError = `frame ${id} missing`; return; }
      const gj = await gjRes.json(); const fj = await fjRes.json();
      if (gen !== _gen) return;
      _count = this._renderColumns(gj);
      _generatedAt = id;
      const drapes = fj.drape && fj.bounds ? [{ url: fj.drape, bounds: fj.bounds }] : [];
      await setDrapes(drapes, gen);
      if (gen !== _gen) return;
      if (fj.png) {
        const img = await loadFieldImage(fj.png, false);
        if (gen !== _gen) return;
        _rng = seededRandom(frameSeed(id));
        this._applyField(fj, img);
      } else {
        _field = null;
        if (_points) for (let i = 0; i < _points.length; i++) _points.get(i).show = false;
      }
      _lastUpdate = Date.now(); _lastError = null;
    },

    _applyField(fj, img) {
      const { cdf, total } = buildSpawnCdf(img.rgba, img.w, img.h);
      if (total <= 0 && _points) { for (let i = 0; i < _points.length; i++) _points.get(i).show = false; }
      const b = fj.bounds;
      _field = { cdf, total, w: img.w, h: img.h, bounds: b, sites: fj.sites || [],
        cellLon: (b.east - b.west) / img.w, cellLat: (b.north - b.south) / img.h,
        cellDeg: (b.north - b.south) / img.h };
      _particles = new Array(PARTICLE_COUNT);
      reseed();
    },

    /**
     * Fetch the archive manifest. `refresh=true` re-reads it (the cron appends a
     * frame every hour; a memoised manifest froze the slider for the page's life —
     * panel audit 2026-09-11). New frames sort after existing ones, so replay
     * indices stay valid; the slider range is widened in place.
     */
    async _loadManifest(refresh = false) {
      if (_manifest !== null && !refresh) return _manifest;
      try {
        const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`);
        if (!res.ok) { if (_manifest === null) _manifest = false; return _manifest; }
        const m = await res.json();
        m.ids = Object.keys(m.frames || {}).sort();
        if (!m.ids.length) { if (_manifest === null) _manifest = false; return _manifest; }
        _manifest = m;
      } catch { if (_manifest === null) _manifest = false; }
      return _manifest;
    },

    /** Enter replay at a frame index; leave with setMode('live'). */
    async seek(index) {
      if (!_manifest || !_manifest.ids.length) return;
      const i = Math.max(0, Math.min(_manifest.ids.length - 1, Math.floor(index)));
      _mode = 'replay';
      _replay = { ..._replay, index: i, frameId: _manifest.ids[i] };
      clearTimeout(_seekTimer);
      _seekTimer = setTimeout(() => { this._showFrame(_manifest.ids[i]); }, SEEK_DEBOUNCE_MS);
    },

    async setMode(mode) {
      if (mode === 'live' && _mode !== 'live') {
        _mode = 'live'; _rng = Math.random; ++_gen; _replay = null;
        await this.update();
      }
    },
    getMode() { return _mode; },
    getReplayInfo() { return _manifest ? { frames: _manifest.ids.length, index: _replay?.index ?? null, frameId: _replay?.frameId ?? null } : null; },

    /**
     * Shared observed-time hook (src/observedTime.js): show the newest archived
     * hourly frame at or before `iso`; null returns to live. An instant before
     * the archive start has nothing to show and returns false.
     */
    async setObservedTime(iso) {
      if (!iso) { await this.setMode('live'); return true; }
      const m = await this._loadManifest();
      if (!m) return false;
      const id = frameIdAtOrBefore(m.ids, iso);
      if (!id) return false;
      if (_mode === 'replay' && _replay?.frameId === id) return true;
      _mode = 'replay';
      _replay = { index: m.ids.indexOf(id), frameId: id };
      clearTimeout(_seekTimer);
      await this._showFrame(id);
      return true;
    },

    /** Field JSON → drapes + particle seed. Absent field file is not an error (M1 data only). */
    async _updateField() {
      if (!_viewer || typeof document === 'undefined') return;
      const res = await fetch(`${FIELD_URL}?t=${Date.now()}`);
      if (res.status === 404) { _field = null; removeImagery(); return; }
      if (!res.ok) throw new Error(`birds_field.json HTTP ${res.status}`);
      const fj = await res.json();
      const gen = ++_gen;
      await setDrapes((fj.sites || []).map((s) => ({ url: s.png, bounds: s.bounds, bust: true })), gen);
      if (gen !== _gen) return;
      const img = await loadFieldImage(fj.png, true);
      if (gen !== _gen) return;
      this._applyField(fj, img);
      console.log(`[Data:Birds] Field: ${_imagery.length} drapes, ${_field.total > 0 ? PARTICLE_COUNT : 0} particles`);
    },

    destroy(viewer) {
      this.disable();
      removeImagery();
      _replay = null; _manifest = null; _mode = 'live';
      _params = { ...DEFAULT_PARAMS }; _fade = 1;
      if (_clickHandler) { _clickHandler.destroy(); _clickHandler = null; }
      if (_points && viewer.scene?.primitives) { viewer.scene.primitives.remove(_points); }
      _points = null; _particles = []; _field = null;
      if (_dataSource) { viewer.dataSources.remove(_dataSource, true); _dataSource = null; }
      _viewer = null;
      _count = 0; _lastUpdate = null; _lastError = null; _generatedAt = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const now = Cesium.JulianDate.now();
      return _dataSource.entities.values.slice(0, maxCount).map((e, i) => {
        const p = e.properties;
        const get = (k) => p?.[k]?.getValue(now);
        return mapBirdRecord({
          site: get('site'), name: get('name'), density_birds_km3: get('density_birds_km3'),
          heading_deg: get('heading_deg'), speed_ms: get('speed_ms'), peak_altitude_m: get('peak_altitude_m'),
          scan_time: get('scan_time'), stale: get('stale'), lat: get('lat'), lon: get('lon'),
        }, i);
      });
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError, generatedAt: _generatedAt,
        drapes: _imagery.length, particles: _field && _field.total > 0 ? PARTICLE_COUNT : 0, mode: _mode };
    },
  };
  return layer;
}

const birdsLayer = createBirdsLayer();
export default birdsLayer;
