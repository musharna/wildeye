import * as Cesium from 'cesium';

/**
 * Generic single-image drape layer driven by public/data/rasters.json
 * (written by pipeline/raster.py). One ImageryLayer per product; the new
 * image is fully loaded before the old one is removed.
 */
const MANIFEST_URL = 'data/rasters.json';

/** Pick this layer's manifest entry (pure). */
export function pickProduct(manifest, id) {
  const list = manifest?.products;
  if (!Array.isArray(list)) return null;
  return list.find((p) => p && p.id === id) || null;
}

export function createRasterDrapeLayer({ id, name, icon, source, alpha = 0.6, updateInterval = 3600000 }) {
  let _viewer = null;
  let _layer = null;
  let _entry = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _gen = 0;

  const layer = {
    id, name, icon, source, updateInterval,

    init(viewer) { _viewer = viewer; console.log(`[Data:${id}] Initialized`); },
    enable() { _enabled = true; if (_layer) _layer.show = true; },
    disable() { _enabled = false; if (_layer) _layer.show = false; },

    async update() {
      if (!_viewer) return false;
      try {
        const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`);
        if (!res.ok) { _lastError = `rasters.json HTTP ${res.status}`; return false; }
        const entry = pickProduct(await res.json(), id);
        if (!entry || !entry.png || !entry.bounds) { _lastError = `no product ${id} in rasters.json`; return false; }
        if (_entry && _entry.time === entry.time && _entry.png === entry.png && _layer) {
          _lastUpdate = Date.now(); _lastError = null; return true; // unchanged
        }
        const gen = ++_gen;
        const b = entry.bounds;
        const provider = await Cesium.SingleTileImageryProvider.fromUrl(`${entry.png}?t=${entry.time || Date.now()}`, {
          rectangle: Cesium.Rectangle.fromDegrees(b.west, b.south, b.east, b.north),
        });
        if (gen !== _gen || !_viewer) return false;
        const il = new Cesium.ImageryLayer(provider, { alpha });
        il.show = _enabled;
        _viewer.imageryLayers.add(il);
        if (_layer) _viewer.imageryLayers.remove(_layer, true);
        _layer = il; _entry = entry;
        _lastUpdate = Date.now(); _lastError = null;
        console.log(`[Data:${id}] Updated: ${entry.time}${entry.stale ? ' (stale)' : ''}`);
        return true;
      } catch (e) {
        console.warn(`[Data:${id}] update error:`, e);
        _lastError = `${id} load error`;
        return false;
      }
    },

    destroy(viewer) {
      if (_layer && viewer?.imageryLayers) viewer.imageryLayers.remove(_layer, true);
      _layer = null; _entry = null; _viewer = null; _enabled = false;
    },

    getRowControls() {
      return { chips: [], legend: _entry?.legend ? [{ label: _entry.legend, color: 'transparent', count: null }] : [] };
    },

    getStats() {
      return { count: _entry ? 1 : 0, lastUpdate: _lastUpdate, error: _lastError,
        time: _entry?.time ?? null, stale: Boolean(_entry?.stale) };
    },
  };
  return layer;
}

export const crwBleachingLayer = createRasterDrapeLayer({
  id: 'crw-bleaching', name: 'Coral bleaching alert', icon: '🪸', source: 'NOAA Coral Reef Watch', alpha: 0.7,
});
export const oisstLayer = createRasterDrapeLayer({
  id: 'oisst', name: 'Sea surface temperature', icon: '🌡️', source: 'NOAA OISST v2.1', alpha: 0.5,
});
