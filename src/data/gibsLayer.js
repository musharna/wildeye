import * as Cesium from "cesium";
import { setStackedImagery, legendItems } from "./rasterDrape.js";
import { dateAtOrBefore, latestDate, extentOfTimes } from "./gibsTime.js";
import { createTilePixelReader, decodePixel, gibsTileRequest } from "./gibsReadout.js";

/**
 * NASA GIBS tile layers (grill ledger 2026-09-22). Tiles load straight from GIBS; public/data/gibs.json
 * (pipeline/gibs.py) says which dates each layer serves and carries NASA's legend. The date drawn is
 * resolved here and put in the URL, because GIBS answers an unserved date with a neighbouring image.
 */
export const GIBS_WMTS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
export const MANIFEST_URL = "data/gibs.json";
export const TILE_FAILURE_LIMIT = 8;

/** An undated layer (no time dimension in GIBS, e.g. the SEDAC grids): one snapshot, its year in entry.asOf. */
const isUndated = (entry) => !entry.times?.length;

const BLACK_THRESHOLD = 0.004; // Cesium's colorToAlphaThreshold default: RGB distance, 0-1 per channel
/**
 * Black to transparent, when the colour map only ever declares black transparent (entry.noData, pipeline/gibs.py)
 * and no data colour is within Cesium's threshold of it: GIBS's empty SEDAC tile in EPSG:3857 is opaque black with
 * no tRNS chunk (probe 2026-10-02). GEDI draws black as data, and EVI draws 0,0,1, so theirs stays.
 */
function blackIsNoData(entry) {
  if (!(entry.noData || []).some((c) => c.join(",") === "0,0,0")) return false;
  const data = [...(entry.decode || []).map((e) => e.slice(0, 3)), ...(entry.classes || []).map((c) => c.rgb)];
  return !data.some((c) => Math.hypot(...c) / 255 < BLACK_THRESHOLD);
}

export function gibsTileUrl(entry, date) {
  // GIBS serves an undated layer at a URL with no date segment
  const when = isUndated(entry) ? "" : `${date}/`;
  return `${GIBS_WMTS}/${entry.gibsId}/default/${when}${entry.tileMatrixSet}/{z}/{y}/{x}.${entry.format}`;
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
  // (url, px, py) → {rgba, timeActual}: one pixel of the raw tile (stage 3 readout)
  readTilePixel = createTilePixelReader(),
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
    if (isUndated(_entry)) {
      if (!_entry.asOf) throw new Error(`${id}: GIBS serves no dates and gibs.json gives no asOf`);
      return _entry.asOf;
    }
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
    // a tile failure belongs to the provider that earned it, not to the layer
    if (_lastError === "map tiles failing") _lastError = null;
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
    // In a class map the colour is the datum, so it is drawn opaque to match its legend swatch; only a
    // continuous overlay may let the basemap through.
    _imagery = imageryLayerFor(provider, {
      alpha: _entry.classes?.length ? 1 : alpha,
      ...(blackIsNoData(_entry) ? { colorToAlpha: Cesium.Color.BLACK, colorToAlphaThreshold: BLACK_THRESHOLD } : {}),
    });
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
        // Cesium never re-requests a failed tile; a fresh provider on the same date is the retry
        if (_lastError === "map tiles failing") drop();
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
    /**
     * What this layer holds at a point, labelled with ITS OWN date (grill A7): the date on screen, unless
     * GIBS's layer-time-actual header says otherwise (then the header wins, loudly). Night lights has no
     * colour map, so it is view only (A8). A layer in a time-bar gap reads no tile. Null when disabled.
     */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_entry) return row("error", { error: `${id} not loaded` });
      if (!_entry.classes && !_entry.decode) return row("viewonly");
      if (_gap) return row("gap", { observed: _observed });
      if (!_shownDate) return row("error", { error: `${id} not loaded` });
      const date = _shownDate;
      const req = gibsTileRequest(gibsTileUrl(_entry, date), _entry.maximumLevel, lat, lon);
      if (!req) return row("outside", { date });
      let pixel;
      try {
        pixel = await readTilePixel(req.url, req.px, req.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url: req.url, error: e });
        return row("error", { date, error: e?.message || String(e) });
      }
      let shown = date;
      // an undated layer's tiles carry GIBS's placeholder layer-time-actual (2899-12-31): its date is asOf
      if (!isUndated(_entry) && pixel.timeActual && pixel.timeActual !== date) {
        console.error(`[Data:${id}] layer-time-actual ${pixel.timeActual} differs from the date shown ${date}`, { url: req.url });
        shown = pixel.timeActual;
      }
      const v = decodePixel(_entry, pixel.rgba);
      if (v.kind === "nodata") return row("nodata", { date: shown });
      if (v.kind === "unknown") return row("error", { date: shown, error: `unknown colour ${v.rgb.join(",")}` });
      return row(v.kind, { date: shown, text: v.kind === "class" ? v.label : v.text });
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
// SEDAC grids of IUCN 2013 ranges (spec 2026-10-02-sedac-richness-design.md): undated in GIBS, so drawn at any time
export const gibsAmphibianLayer = createGibsLayer({
  id: "gibs-amphibians",
  name: "Amphibian species (SEDAC, IUCN 2013)",
  icon: "🐸",
  source: "NASA GIBS · SEDAC amphibian richness",
  zrank: 22,
});
export const gibsMammalLayer = createGibsLayer({
  id: "gibs-mammals",
  name: "Mammal species (SEDAC, IUCN 2013)",
  icon: "🦊",
  source: "NASA GIBS · SEDAC mammal richness",
  zrank: 23,
});
