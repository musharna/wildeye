import * as Cesium from 'cesium';
import { columnEntity, mapBirdRecord } from './birds.js';

/**
 * European bird migration from Aloft / BALTRAD vertical profiles (CC0).
 * One column per OPERA radar, latest profile with data (daily files, ~1–2 day lag).
 * Profiles only: raw European radar volumes are not redistributable, so no drape.
 */
const DATA_URL = 'data/aloft.geojson';

function describeAloft(p, h) {
  const head = `<b>${p.name ?? p.site}</b> (${p.site}) — Aloft / BALTRAD profile<br>`;
  const body = h > 0
    ? `${Number(p.density_birds_km3).toFixed(1)} birds/km³ (0–3 km mean), heading ${Math.round(p.heading_deg)}°, ` +
      `${Number(p.speed_ms ?? 0).toFixed(0)} m/s, peak ${p.peak_altitude_m} m`
    : 'Quiet — no biological echo in the latest profile';
  return `${head}${body}<br>profile ${p.scan_time} · published daily, 1–2 day lag · CC0`;
}

export function createAloftLayer() {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _generatedAt = null;

  const layer = {
    id: 'aloft',
    name: 'Bird migration (Europe, radar profiles)',
    icon: '🐦‍⬛',
    source: 'Aloft / BALTRAD_VPTS (CC0)',
    updateInterval: 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('aloft');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0; _lastUpdate = null; _lastError = null; _generatedAt = null;
      console.log('[Data:Aloft] Initialized');
    },
    enable() { if (_dataSource) _dataSource.show = true; },
    disable() { if (_dataSource) _dataSource.show = false; },

    async update() {
      try {
        const res = await fetch(`${DATA_URL}?t=${Date.now()}`);
        if (!res.ok) { _lastError = `aloft.geojson HTTP ${res.status}`; return false; }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) { _lastError = 'Malformed aloft.geojson'; return false; }
        _dataSource.entities.removeAll();
        let count = 0;
        for (const f of gj.features) { count++; _dataSource.entities.add(columnEntity(f, 'aloft', describeAloft)); }
        _count = count; _generatedAt = gj.generated_at ?? null; _lastUpdate = Date.now(); _lastError = null;
        console.log(`[Data:Aloft] Updated: ${count} radars, generated ${_generatedAt}`);
        return true;
      } catch (e) {
        console.warn('[Data:Aloft] Fetch error:', e);
        _lastError = 'aloft.geojson network error';
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
        const p = e.properties; const get = (k) => p?.[k]?.getValue(now);
        return mapBirdRecord({ site: get('site'), name: get('name'), density_birds_km3: get('density_birds_km3'),
          heading_deg: get('heading_deg'), speed_ms: get('speed_ms'), peak_altitude_m: get('peak_altitude_m'),
          scan_time: get('scan_time'), stale: get('stale'), lat: get('lat'), lon: get('lon') }, i);
      });
    },

    getStats() { return { count: _count, lastUpdate: _lastUpdate, error: _lastError, generatedAt: _generatedAt }; },
  };
  return layer;
}

const aloftLayer = createAloftLayer();
export default aloftLayer;
