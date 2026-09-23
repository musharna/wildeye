import * as Cesium from "cesium";
import { setStackedImagery, legendItems } from "./rasterDrape.js";
import { dateAtOrBefore, latestDate, extentOfTimes } from "./gibsTime.js";

/**
 * NASA GIBS tile layers (grill ledger 2026-09-22). Tiles load straight from GIBS; public/data/gibs.json
 * (pipeline/gibs.py) says which dates each layer serves and carries NASA's legend. The date drawn is
 * resolved here and put in the URL, because GIBS answers an unserved date with a neighbouring image.
 */
export const GIBS_WMTS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
export const MANIFEST_URL = "data/gibs.json";
export const TILE_FAILURE_LIMIT = 8;

export function gibsTileUrl(entry, date) {
  return `${GIBS_WMTS}/${entry.gibsId}/default/${date}/${entry.tileMatrixSet}/{z}/{y}/{x}.${entry.format}`;
}

async function fetchJsonDefault(url) {
  const res = await fetch(`${url}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
}

export function createGibsLayer({
  id,
  name,
  icon,
  source,
  alpha = 0.7,
  zrank = 50,
  timeless = false,
  fetchJson = fetchJsonDefault,
  providerFor = (url, options) =>
    new Cesium.UrlTemplateImageryProvider({
      url,
      credit: "NASA GIBS",
      ...options,
    }),
  imageryLayerFor = (provider, options) =>
    new Cesium.ImageryLayer(provider, options),
  stack = setStackedImagery,
}) {
  let _viewer = null,
    _entry = null,
    _imagery = null,
    _shownDate = null;
  let _enabled = false,
    _observed = null,
    _gap = false;
  let _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, id, null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
    _shownDate = null;
  };

  const targetDate = () => {
    if (timeless || !_observed) return latestDate(_entry.times);
    return dateAtOrBefore(_entry.times, _observed);
  };

  const show = (date) => {
    if (date === _shownDate && _imagery) {
      _imagery.show = _enabled;
      return;
    }
    drop();
    _generation += 1;
    _tileFailures = 0;
    const generation = _generation;
    const provider = providerFor(gibsTileUrl(_entry, date), {
      maximumLevel: _entry.maximumLevel,
    });
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      const error = tileError?.error ?? tileError;
      if (!(error instanceof Cesium.RequestErrorEvent)) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = "map tiles failing";
        console.error(`[Data:${id}] GIBS tiles failing`, { date, error });
      }
    });
    _imagery = imageryLayerFor(provider, { alpha });
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
    _shownDate = date;
  };

  const apply = () => {
    const date = targetDate();
    _gap = !date;
    if (_gap) {
      if (_imagery) _imagery.show = false;
      _lastError = `no ${id} data at or before ${String(_observed).slice(0, 10)}`;
      return;
    }
    if (_lastError && _lastError !== "map tiles failing") _lastError = null;
    show(date);
  };

  return {
    id,
    name,
    icon,
    source,
    updateInterval: 6 * 3600000,
    init(viewer) {
      _viewer = viewer;
    },
    enable() {
      _enabled = true;
      if (_imagery) _imagery.show = !_gap;
    },
    disable() {
      _enabled = false;
      if (_imagery) _imagery.show = false;
    },
    async update() {
      if (!_viewer) return false;
      try {
        const entry = (await fetchJson(MANIFEST_URL))?.layers?.[id];
        if (!entry) {
          _lastError = `no ${id} in gibs.json`;
          return false;
        }
        _entry = entry;
        apply();
        _lastUpdate = Date.now();
        return true;
      } catch (e) {
        console.warn(`[Data:${id}] update error:`, e);
        _lastError = `${id} load error`;
        return false;
      }
    },
    async setObservedTime(iso) {
      _observed = iso || null;
      if (!_entry || !_viewer || timeless) return true;
      apply();
      return true;
    },
    getObservedExtent() {
      return timeless || !_entry ? null : extentOfTimes(_entry.times);
    },
    destroy() {
      drop();
      _viewer = null;
      _entry = null;
      _enabled = false;
      _observed = null;
    },
    getRowControls() {
      const legend = legendItems(_entry);
      if (_entry?.legend && (_entry.classes || _entry.ramp))
        legend.push({
          label: _entry.legend,
          color: "transparent",
          count: null,
        });
      return { chips: [], legend };
    },
    getStats() {
      return {
        count: _entry ? 1 : 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        time: _shownDate,
        latest: _entry ? latestDate(_entry.times) : null,
        observed: _observed,
      };
    },
  };
}

export const gibsLandCoverLayer = createGibsLayer({
  id: "gibs-landcover",
  name: "Land cover (MODIS IGBP, yearly)",
  icon: "🗺️",
  source: "NASA GIBS · MODIS land cover",
  zrank: 14,
});
export const gibsEviLayer = createGibsLayer({
  id: "gibs-evi",
  name: "Vegetation vigour (MODIS EVI, 16-day)",
  icon: "🌱",
  source: "NASA GIBS · MODIS Terra EVI",
  zrank: 16,
});
export const gibsLstLayer = createGibsLayer({
  id: "gibs-lst",
  name: "Land surface temperature (MODIS, 8-day day)",
  icon: "♨️",
  source: "NASA GIBS · MODIS Terra LST",
  zrank: 17,
});
export const gibsNightLightsLayer = createGibsLayer({
  id: "gibs-nightlights",
  name: "Night lights (VIIRS Black Marble)",
  icon: "🌃",
  source: "NASA GIBS · VIIRS Black Marble",
  alpha: 0.85,
  zrank: 18,
});
export const gibsBiomassLayer = createGibsLayer({
  id: "gibs-biomass",
  name: "Forest biomass (GEDI, 2019–2023)",
  icon: "🌳",
  source: "NASA GIBS · GEDI L4B",
  zrank: 19,
  timeless: true,
});
