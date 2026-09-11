import * as Cesium from 'cesium';

/**
 * Nocturnal bird migration density per NEXRAD radar, produced by
 * pipeline/build_birds.py (vol2bird on Level II volumes). One column per
 * radar: height ∝ density, hue = heading. Static geometry between polls.
 */
const DATA_URL = 'data/birds.geojson';
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

  const layer = {
    id: 'birds',
    name: 'Bird migration (radar)',
    icon: '🐦',
    source: 'NEXRAD via vol2bird',
    updateInterval: 600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('birds');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0; _lastUpdate = null; _lastError = null; _generatedAt = null;
      console.log('[Data:Birds] Initialized');
    },
    enable() { if (_dataSource) _dataSource.show = true; },
    disable() { if (_dataSource) _dataSource.show = false; },

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

    destroy(viewer) {
      if (_dataSource) { viewer.dataSources.remove(_dataSource, true); _dataSource = null; }
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

    getStats() { return { count: _count, lastUpdate: _lastUpdate, error: _lastError, generatedAt: _generatedAt }; },
  };
  return layer;
}

const birdsLayer = createBirdsLayer();
export default birdsLayer;
