import * as Cesium from 'cesium';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { buildSpawnCdf, sampleCell, idwVelocity, stepParticle, birdsPerParticle } from './birdsField.js';

/**
 * Nocturnal bird migration density per NEXRAD radar, produced by
 * pipeline/build_birds.py (vol2bird on Level II volumes). One column per
 * radar: height ∝ density, hue = heading. Static geometry between polls.
 */
const DATA_URL = 'data/birds.geojson';
const FIELD_URL = 'data/birds_field.json';
const PARTICLE_COUNT = 4000;
const PARTICLE_LIFE_S = 90;
const PARTICLE_ALT_M = 600;
const DRAPE_ALPHA = 0.7;
const MAX_COLUMN_M = 200000;
const BASE_RADIUS_M = 25000;

export function birdColumn(density) {
  const d = Number(density);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.min(MAX_COLUMN_M, 8000 * Math.log1p(d));
}

export function headingColor(deg) {
  const h = Number(deg);
  if (!Number.isFinite(h)) return Cesium.Color.GRAY;
  return Cesium.Color.fromHsl((((h % 360) + 360) % 360) / 360, 0.9, 0.55);
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

function describe(p, h) {
  const head = `<b>${p.name ?? p.site}</b> (${p.site})<br>`;
  const body = h > 0
    ? `${Number(p.density_birds_km3).toFixed(1)} birds/km³, heading ${Math.round(p.heading_deg)}°, ` +
      `${Number(p.speed_ms ?? 0).toFixed(0)} m/s, peak ${p.peak_altitude_m} m`
    : 'Quiet — no migration signal (daytime or clear)';
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

  function removeImagery() {
    if (!_viewer) return;
    for (const il of _imagery) _viewer.imageryLayers.remove(il, true);
    _imagery = [];
  }

  async function loadDrapes(sites) {
    removeImagery();
    const layers = await Promise.all(sites.filter((s) => s.png && s.bounds).map(async (s) => {
      const b = s.bounds;
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(`${s.png}?t=${Date.now()}`, {
        rectangle: Cesium.Rectangle.fromDegrees(b.west, b.south, b.east, b.north),
      });
      const il = new Cesium.ImageryLayer(provider, { alpha: DRAPE_ALPHA });
      il.show = _enabled;
      return il;
    }));
    for (const il of layers) { _viewer.imageryLayers.add(il); _imagery.push(il); }
  }

  function loadFieldImage(url) {
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
      img.src = `${url}?t=${Date.now()}`;
    });
  }

  function spawn(i) {
    const f = _field;
    const cell = sampleCell(f.cdf, Math.random());
    const row = Math.floor(cell / f.w), col = cell % f.w;
    const lon = f.bounds.west + (col + Math.random()) * f.cellLon;
    const lat = f.bounds.north - (row + Math.random()) * f.cellLat;
    const { u, v } = idwVelocity(f.sites, lon, lat);
    const p = { lon, lat, u, v, age: Math.random() * PARTICLE_LIFE_S * 0.5, dead: false, cell };
    _particles[i] = p;
    const pt = _points.get(i);
    pt.position = Cesium.Cartesian3.fromDegrees(lon, lat, PARTICLE_ALT_M);
    pt.color = headingColor((Math.atan2(u, v) * 180) / Math.PI).withAlpha(0.85);
    pt.show = true;
  }

  function reseed() {
    if (!_points || !_field || _field.total <= 0) return;
    while (_points.length < PARTICLE_COUNT) {
      _points.add({ id: `birds-particle:${_points.length}`, pixelSize: 3, show: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY });
    }
    for (let i = 0; i < PARTICLE_COUNT; i++) spawn(i);
  }

  function onTick(clock) {
    if (!_enabled || !_field || !_points || _field.total <= 0) return;
    const now = clock.currentTime;
    const dt = _lastTick ? Math.min(2, Math.abs(Cesium.JulianDate.secondsDifference(now, _lastTick))) : 0;
    _lastTick = now;
    if (dt === 0) return;
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
    const n = birdsPerParticle(dens, p.lat, f.cellDeg, weight / f.total, PARTICLE_COUNT);
    const speed = Math.hypot(p.u, p.v);
    const heading = ((Math.atan2(p.u, p.v) * 180) / Math.PI + 360) % 360;
    return `<b>Ensemble contact</b> — represents ~${Math.max(1, Math.round(n)).toLocaleString()} birds (approx.)<br>` +
      `local density ≈ ${dens.toFixed(1)} birds/km³ · heading ${Math.round(heading)}° · ground speed ${speed.toFixed(0)} m/s<br>` +
      `nearest radar ${nearest ? `${nearest.site} (${nearest.name})` : 'n/a'} · scan ${nearest?.scan_time ?? 'n/a'}<br>` +
      `<i>Weather radar resolves crowds, not individuals; this dot is a statistical stand-in.</i>`;
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
      if (_dataSource) _dataSource.show = true;
      for (const il of _imagery) il.show = true;
      if (_points) _points.show = true;
      if (viewer?.clock && !_tickRemover) {
        _lastTick = null;
        _tickRemover = viewer.clock.onTick.addEventListener(onTick);
        holdContinuousRender('birds'); // per-frame particle animator
      }
    },
    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      for (const il of _imagery) il.show = false;
      if (_points) _points.show = false;
      if (_tickRemover) { _tickRemover(); _tickRemover = null; }
      releaseContinuousRender('birds');
    },

    async update() {
      try {
        const res = await fetch(`${DATA_URL}?t=${Date.now()}`);
        if (!res.ok) { _lastError = `birds.geojson HTTP ${res.status}`; return false; }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) { _lastError = 'Malformed birds.geojson'; return false; }
        _dataSource.entities.removeAll();
        let count = 0;
        for (const f of gj.features) {
          const [lon, lat] = f.geometry.coordinates;
          const p = f.properties || {};
          const h = birdColumn(p.density_birds_km3);
          const color = headingColor(p.heading_deg).withAlpha(p.stale ? 0.25 : 0.6);
          count++;
          _dataSource.entities.add({
            id: `birds:${p.site}`,
            position: Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(h, 500) / 2),
            cylinder: {
              length: Math.max(h, 500),
              topRadius: BASE_RADIUS_M,
              bottomRadius: BASE_RADIUS_M,
              material: new Cesium.ColorMaterialProperty(color),
              outline: true,
              outlineColor: color.withAlpha(0.9),
            },
            description: describe(p, h),
            properties: { ...p, lat, lon },
          });
        }
        _count = count;
        _generatedAt = gj.generated_at ?? null;
        await this._updateField();
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Birds] Updated: ${count} radars, generated ${_generatedAt}`);
        return true;
      } catch (e) {
        console.warn('[Data:Birds] Fetch error:', e);
        _lastError = 'birds.geojson network error';
        return false;
      }
    },

    /** Field JSON → drapes + particle seed. Absent field file is not an error (M1 data only). */
    async _updateField() {
      if (!_viewer || typeof document === 'undefined') return;
      const res = await fetch(`${FIELD_URL}?t=${Date.now()}`);
      if (res.status === 404) { _field = null; removeImagery(); return; }
      if (!res.ok) throw new Error(`birds_field.json HTTP ${res.status}`);
      const fj = await res.json();
      await loadDrapes(fj.sites || []);
      const img = await loadFieldImage(fj.png);
      const { cdf, total } = buildSpawnCdf(img.rgba, img.w, img.h);
      const b = fj.bounds;
      _field = { cdf, total, w: img.w, h: img.h, bounds: b, sites: fj.sites || [],
        cellLon: (b.east - b.west) / img.w, cellLat: (b.north - b.south) / img.h,
        cellDeg: (b.north - b.south) / img.h };
      _particles = new Array(PARTICLE_COUNT);
      reseed();
      console.log(`[Data:Birds] Field: ${_imagery.length} drapes, ${total > 0 ? PARTICLE_COUNT : 0} particles`);
    },

    destroy(viewer) {
      this.disable();
      removeImagery();
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
        drapes: _imagery.length, particles: _field && _field.total > 0 ? PARTICLE_COUNT : 0 };
    },
  };
  return layer;
}

const birdsLayer = createBirdsLayer();
export default birdsLayer;
