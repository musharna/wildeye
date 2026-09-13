import * as Cesium from 'cesium';
import { densityTileTemplate, RADII_KM } from '../bio/gbif.js';
import { setStackedImagery } from './rasterDrape.js';

/**
 * Species map (spec: docs/superpowers/specs/2026-09-13-species-search-design.md): GBIF hexagon tiles for the
 * taxon chosen in the SPECIES panel, CC0 and CC BY records only. Browser-side, so it works on the static host.
 * Joins the shared drape stack at SPECIES_ZRANK so drape refreshes cannot bury it.
 */
export const SPECIES_ZRANK = 1000;
export const SPECIES_ALPHA = 0.7;
export const SPECIES_YEARS = Object.freeze(['recent', 'all']);
export const TILE_FAILURE_LIMIT = 8;
export const DEFAULT_SPECIES_PARAMS = Object.freeze({ taxonKey: null, name: null, years: 'recent', radiusKm: 10 });

/** Merge a params request; null when any supplied value is invalid. A new taxon clears the old name. */
export function mergeSpeciesParams(current, request = {}) {
  const next = { ...current };
  if (Object.hasOwn(request, 'taxonKey')) {
    const key = request.taxonKey;
    if (key !== null && !(Number.isInteger(key) && key > 0)) return null;
    if (key !== next.taxonKey) next.name = null;
    next.taxonKey = key;
  }
  if (Object.hasOwn(request, 'name')) {
    if (request.name !== null && typeof request.name !== 'string') return null;
    next.name = request.name;
  }
  if (Object.hasOwn(request, 'years')) {
    if (!SPECIES_YEARS.includes(request.years)) return null;
    next.years = request.years;
  }
  if (Object.hasOwn(request, 'radiusKm')) {
    if (!RADII_KM.includes(request.radiusKm)) return null;
    next.radiusKm = request.radiusKm;
  }
  return next;
}

export function createSpeciesLayer({
  providerFor = (url) => new Cesium.UrlTemplateImageryProvider({ url, maximumLevel: 14, credit: 'GBIF.org' }),
  imageryLayerFor = (provider, options) => new Cesium.ImageryLayer(provider, options),
  stack = setStackedImagery,
  now = () => new Date(),
} = {}) {
  let _viewer = null;
  let _imagery = null;
  let _enabled = false;
  let _params = { ...DEFAULT_SPECIES_PARAMS };
  let _generation = 0;
  let _tileFailures = 0;
  let _lastError = null;
  let _lastUpdate = null;
  const _statusListeners = new Set();
  const notify = () => { for (const listener of _statusListeners) listener(); };

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, 'species', null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
  };

  const rebuild = () => {
    drop();
    _generation += 1;
    _tileFailures = 0;
    _lastError = null;
    if (!_viewer || !_params.taxonKey) return;
    const generation = _generation;
    const provider = providerFor(densityTileTemplate({ taxonKey: _params.taxonKey, years: _params.years, now: now() }));
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      const error = tileError?.error ?? tileError;
      // GBIF answers empty tiles with HTTP 204 and no body, which Cesium rejects as a RuntimeError ("contained no
      // content"). Only HTTP and network failures, which Cesium reports as RequestErrorEvent, count as failures.
      if (!(error instanceof Cesium.RequestErrorEvent)) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = 'map tiles failing';
        console.error('[Data:species] GBIF tiles failing', { taxonKey: _params.taxonKey, years: _params.years, error });
        notify();
      }
    });
    _imagery = imageryLayerFor(provider, { alpha: SPECIES_ALPHA });
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, 'species', _imagery, SPECIES_ZRANK);
    _lastUpdate = Date.now();
  };

  return {
    id: 'species',
    name: 'Species map (GBIF)',
    icon: '🔎',
    source: 'GBIF.org occurrence maps, CC0 and CC BY records only',
    updateInterval: 0,
    showInTogglePanel: false,

    init(viewer) {
      _viewer = viewer;
      rebuild();
      console.log('[Data:species] Initialized');
    },
    enable() { _enabled = true; if (_imagery) _imagery.show = true; },
    disable() { _enabled = false; if (_imagery) _imagery.show = false; },
    async update() { return true; },
    destroy() { drop(); _viewer = null; },

    setParams(params = {}) {
      const next = mergeSpeciesParams(_params, params);
      if (!next) return false;
      const tilesChanged = next.taxonKey !== _params.taxonKey || next.years !== _params.years;
      _params = next;
      if (tilesChanged) rebuild();
      notify();
      return true;
    },
    getParams() { return { ..._params }; },
    getStats() {
      return { count: _params.taxonKey ? 1 : 0, lastUpdate: _lastUpdate, error: _lastError, tileFailures: _tileFailures };
    },
    /** The SPECIES panel listens here for tile-failure status. */
    onStatus(listener) {
      if (typeof listener !== 'function') return () => {};
      _statusListeners.add(listener);
      return () => _statusListeners.delete(listener);
    },
  };
}

const speciesLayer = createSpeciesLayer();
export default speciesLayer;
