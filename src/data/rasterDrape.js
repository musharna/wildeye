import * as Cesium from 'cesium';

/**
 * Generic single-image drape layer driven by public/data/rasters.json
 * (written by pipeline/raster.py). One ImageryLayer per product; the new
 * image is fully loaded before the old one is removed.
 */
const MANIFEST_URL = 'data/rasters.json';

/**
 * Deterministic stacking for drapes. Every drape ImageryLayer is appended on top
 * of whatever was there, so the order used to depend on which fetch finished
 * last (panel audit 2026-09-11). Registered drapes are re-added in `zrank`
 * order after each change: continuous fields (SST, chlorophyll) low, class
 * overlays (bleaching alerts) high, ties broken by id.
 */
const _stack = new Map(); // id → { layer, zrank }
export function restackDrapes(imageryLayers) {
  const order = [..._stack.entries()].sort(([ia, a], [ib, b]) => (a.zrank - b.zrank) || (ia < ib ? -1 : 1));
  for (const [, e] of order) if (imageryLayers.contains?.(e.layer) ?? true) imageryLayers.remove(e.layer, false);
  for (const [, e] of order) imageryLayers.add(e.layer);
  return order.map(([id]) => id);
}
export function _drapeStackForTest() { return _stack; }

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
/** Legend items (label + colour) from the manifest entry: discrete classes or a continuous ramp. */
export function legendItems(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.classes)) {
    return entry.classes.filter((c) => !c.hidden).map((c) => ({ label: c.label, color: rgb(c.rgb), count: null }));
  }
  if (entry.ramp && Array.isArray(entry.ramp.stops) && entry.ramp.stops.length) {
    const st = entry.ramp.stops, n = st.length, unit = entry.ramp.unit || '';
    const at = (i) => rgb(st[Math.min(n - 1, Math.max(0, i))]);
    const fmt = (v) => `${v}${unit}`;
    const mid = (entry.ramp.min + entry.ramp.max) / 2;
    return [
      { label: fmt(entry.ramp.min), color: at(0), count: null },
      { label: fmt(entry.ramp.log ? Math.sqrt(entry.ramp.min * entry.ramp.max) : mid), color: at(Math.floor(n / 2)), count: null },
      { label: fmt(entry.ramp.max), color: at(n - 1), count: null },
    ];
  }
  return entry.legend ? [{ label: entry.legend, color: 'transparent', count: null }] : [];
}

/** Nearest archived frame at or before `isoTime` (pure); null when no history or all frames are later. */
export function frameAtOrBefore(history, isoTime) {
  if (!Array.isArray(history) || !history.length) return null;
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) return null;
  let best = null;
  for (const h of history) { const ht = Date.parse(h.time); if (Number.isFinite(ht) && ht <= t && (!best || ht > Date.parse(best.time))) best = h; }
  return best;
}

/** Pick this layer's manifest entry (pure). */
export function pickProduct(manifest, id) {
  const list = manifest?.products;
  if (!Array.isArray(list)) return null;
  return list.find((p) => p && p.id === id) || null;
}

export function createRasterDrapeLayer({ id, name, icon, source, alpha = 0.6, updateInterval = 3600000, zrank = 50,
  // test seams: node has no WebGL, so tests substitute the provider/layer constructors
  providerFor = (url, rectangle) => Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle }),
  imageryLayerFor = (provider, opts) => new Cesium.ImageryLayer(provider, opts) }) {
  let _viewer = null;
  let _layer = null;
  let _entry = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _gen = 0;
  let _observed = null;   // ISO time selected by the shared observed-time selector, or null = latest
  let _shown = null;      // { time, png } currently on the globe

  const layer = {
    id, name, icon, source, updateInterval,

    init(viewer) { _viewer = viewer; console.log(`[Data:${id}] Initialized`); },
    enable() { _enabled = true; if (_layer) _layer.show = !(_observed && !this._target(_entry || {})); },
    disable() { _enabled = false; if (_layer) _layer.show = false; },

    /** Swap the image on the globe. Resolves false when superseded by a newer call. */
    async _show(frame, entry) {
      const gen = ++_gen;
      const b = entry.bounds;
      const provider = await providerFor(`${frame.png}?t=${frame.time || Date.now()}`,
        Cesium.Rectangle.fromDegrees(b.west, b.south, b.east, b.north));
      if (gen !== _gen || !_viewer) return false;
      const il = imageryLayerFor(provider, { alpha });
      il.show = _enabled;
      if (_layer) { _viewer.imageryLayers.remove(_layer, true); _stack.delete(id); }
      _stack.set(id, { layer: il, zrank: Number.isFinite(entry.zrank) ? entry.zrank : zrank });
      restackDrapes(_viewer.imageryLayers);
      _layer = il; _shown = { time: frame.time, png: frame.png };
      return true;
    },

    /**
     * Which frame to show for the current selection: an archived acquisition, the latest
     * when live, or null when the selected instant precedes every archived acquisition —
     * the drape is then hidden rather than showing newer data under an older time.
     */
    _target(entry) {
      if (_observed) return frameAtOrBefore(entry.history, _observed);
      return { time: entry.time, png: entry.png };
    },

    _applyGap(f) {
      const gap = _observed && !f;
      if (_layer) _layer.show = _enabled && !gap;
      _lastError = gap ? `no ${id} acquisition at or before ${_observed}` : null;
      return gap;
    },

    /** Observed-time hook: null = live/latest. Re-renders only when the target frame changes. */
    async setObservedTime(isoTime) {
      _observed = isoTime || null;
      if (!_entry || !_viewer) return false;
      const f = this._target(_entry);
      if (this._applyGap(f)) return true;
      if (_shown && _shown.png === f.png) return true;
      return this._show(f, _entry);
    },
    getHistory() { return _entry?.history ?? []; },

    async update() {
      if (!_viewer) return false;
      try {
        const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`);
        if (!res.ok) { _lastError = `rasters.json HTTP ${res.status}`; return false; }
        const entry = pickProduct(await res.json(), id);
        if (!entry || !entry.png || !entry.bounds) { _lastError = `no product ${id} in rasters.json`; return false; }
        _entry = entry;
        const f = this._target(entry);
        if (this._applyGap(f)) { _lastUpdate = Date.now(); return true; }
        if (_shown && _shown.png === f.png && _shown.time === f.time && _layer) {
          _lastUpdate = Date.now(); _lastError = null; return true; // unchanged
        }
        if (!(await this._show(f, entry))) return false;
        _lastUpdate = Date.now(); _lastError = null;
        console.log(`[Data:${id}] Updated: ${f.time}${entry.stale ? ' (stale)' : ''}${_observed ? ' (observed)' : ''}`);
        return true;
      } catch (e) {
        console.warn(`[Data:${id}] update error:`, e);
        _lastError = `${id} load error`;
        return false;
      }
    },

    destroy(viewer) {
      if (_layer && viewer?.imageryLayers) viewer.imageryLayers.remove(_layer, true);
      _stack.delete(id);
      _layer = null; _entry = null; _viewer = null; _enabled = false; _shown = null; _observed = null;
    },

    getRowControls() {
      const legend = legendItems(_entry);
      if (_entry?.legend && (_entry.classes || _entry.ramp)) legend.push({ label: _entry.legend, color: 'transparent', count: null });
      return { chips: [], legend };
    },

    getStats() {
      return { count: _entry ? 1 : 0, lastUpdate: _lastUpdate, error: _lastError,
        time: _shown?.time ?? _entry?.time ?? null, latest: _entry?.time ?? null, frames: _entry?.history?.length ?? 0,
        observed: _observed, stale: Boolean(_entry?.stale) };
    },
  };
  return layer;
}

export const crwBleachingLayer = createRasterDrapeLayer({
  id: 'crw-bleaching', name: 'Coral bleaching alert (legacy 0–4 scale)', icon: '🪸', source: 'NOAA Coral Reef Watch', alpha: 0.7, zrank: 90,
});
export const oisstLayer = createRasterDrapeLayer({
  id: 'oisst', name: 'Sea surface temperature', icon: '🌡️', source: 'NOAA OISST v2.1', alpha: 0.5, zrank: 10,
});
export const chlorALayer = createRasterDrapeLayer({
  id: 'chlor-a', name: 'Chlorophyll-a / algal blooms', icon: '🦠', source: 'NOAA CoastWatch VIIRS', alpha: 0.6, zrank: 20,
});
