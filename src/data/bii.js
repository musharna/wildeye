import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";
import { decodeFootprint as decodePixel, epochAt, geoTilePixel } from "./humanFootprint.js";
import { cellCentre } from "./mammals.js";

/**
 * Biodiversity Intactness Index, five snapshots 2000–2020 (NHM v2.1.1, De Palma et al. 2024, doi:10.5519/k33reyb6,
 * CC BY-NC-SA 4.0): the modelled share of the original species abundance that remains, 0–100 %, on the 5 arc-minute
 * grid, resampled by nearest neighbour to ~5 km and cut by pipeline/bii.py into a geographic tile pyramid with one
 * palette colour per 1 % bin (spec docs/superpowers/specs/2026-10-03-bii-design.md). On the time bar the snapshot at or
 * before the observed date is drawn; before the first there is none. A point readout decodes the bin exactly from the
 * finest tile.
 */
export const MANIFEST_URL = "data/bii.json";
export const TILE_FAILURE_LIMIT = 8;
const TILE = 256;
const BINS = 100;
const SOURCE = "Biodiversity Intactness Index: NHM v2.1.1";
const SOURCE_CELL = 1 / 12; // degrees: the 5 arc-minute source grid (pipeline/bii.py SOURCE_CELLS)

/** null when bii.json has the shape pipeline/bii.py writes; otherwise what is wrong with it. */
export function validateManifest(m) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  const { years, maxLevel, tile, palette } = m;
  if (!Array.isArray(years) || !years.length || !years.every((y, i) => Number.isInteger(y) && (i === 0 || y > years[i - 1])))
    return `years ${JSON.stringify(years)} is not a rising list of years`;
  if (!Number.isInteger(maxLevel) || maxLevel < 0) return `maxLevel ${JSON.stringify(maxLevel)} is not a level`;
  if (typeof tile !== "string" || !["{year}", "{z}", "{x}", "{y}"].every((k) => tile.includes(k)))
    return `tile ${JSON.stringify(tile)} lacks {year}, {z}, {x} or {y}`;
  if (!Array.isArray(palette) || palette.length !== BINS || !palette.every((c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)))
    return `palette is not ${BINS} RGB colours`;
  if (new Set(palette.map(String)).size !== BINS) return "palette colours are not distinct";
  return null;
}

/** Readout text of a bin: k = 0–98 is [k, k+1) %, 99 is [99, 100] %. */
export function binText(bin) {
  return `BII ${bin}–${bin + 1}%`;
}

export function createBiiLayer({
  id = "bii",
  name = "Biodiversity intactness (NHM, 2000–2020)",
  icon = "🦋",
  fetchImpl = (u) => fetch(u),
  providerFor = (options) => new Cesium.UrlTemplateImageryProvider(options),
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider),
  stack = setStackedImagery,
  readTilePixel = createTilePixelReader(),
  zrank = 21,
} = {}) {
  let _viewer = null,
    _imagery = null,
    _enabled = false,
    _manifest = null,
    _observed = null,
    _drawnYear = null,
    _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  const shown = () => (_manifest ? epochAt(_observed, _manifest.years) : null);
  const tileUrl = (year) => _manifest.tile.replace("{year}", String(year));

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, id, null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
    _drawnYear = null;
  };

  const draw = (year) => {
    drop();
    _generation += 1;
    _tileFailures = 0;
    _lastError = null;
    const generation = _generation;
    const provider = providerFor({
      url: tileUrl(year),
      tilingScheme: new Cesium.GeographicTilingScheme(),
      tileWidth: TILE,
      tileHeight: TILE,
      maximumLevel: _manifest.maxLevel,
      credit: SOURCE,
    });
    // every tile of the pyramid is written, empty ones too: any tile error is a fault
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = "map tiles failing";
        console.error(`[Data:${id}] tiles failing`, { year, error: tileError?.error ?? tileError });
      }
    });
    _imagery = imageryLayerFor(provider);
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
    _drawnYear = year;
  };

  const apply = () => {
    const year = shown();
    if (year === null) {
      if (_imagery) _imagery.show = false;
      _lastError = `no biodiversity intactness mapped before ${_manifest.years[0]} (shown: ${String(_observed).slice(0, 10)})`;
      return;
    }
    if (_lastError?.startsWith("no biodiversity intactness")) _lastError = null;
    if (!_imagery || _drawnYear !== year || _lastError === "map tiles failing") draw(year);
    else _imagery.show = _enabled;
  };

  const load = async () => {
    try {
      const res = await fetchImpl(MANIFEST_URL);
      if (!res.ok) {
        _lastError = `bii.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateManifest(m);
      if (bad) {
        _lastError = `Malformed bii.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      return true;
    } catch (e) {
      _lastError = `bii.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "De Palma et al. 2024, Biodiversity Intactness Index v2.1.1 (NHM) · CC BY-NC-SA 4.0",
    updateInterval: 24 * 3600000,
    init(viewer) {
      _viewer = viewer;
    },
    enable() {
      _enabled = true;
      if (_imagery) _imagery.show = shown() !== null;
    },
    disable() {
      _enabled = false;
      if (_imagery) _imagery.show = false;
    },
    async update() {
      if (!_viewer) return false;
      if (!_manifest && !(await load())) return false;
      apply();
      _lastUpdate = Date.now();
      return true;
    },
    async setObservedTime(iso) {
      if (iso && !Number.isFinite(Date.parse(iso))) return false;
      _observed = iso || null;
      if (_viewer && _manifest) apply();
      return true;
    },
    /** Shared observed-time hook: the first snapshot's Jan 1 to the last one's Dec 31; null until bii.json is read. */
    getObservedExtent() {
      if (!_manifest) return null;
      const y = _manifest.years;
      return { startMs: Date.UTC(y[0], 0, 1), endMs: Date.UTC(y[y.length - 1], 11, 31, 23, 59, 59, 999) };
    },
    destroy() {
      drop();
      _viewer = null;
      _enabled = false;
      _observed = null;
    },
    getRowControls() {
      const legend = _manifest
        ? [0, 20, 40, 60, 80, 100].map((v) => ({ label: `${v}%`, color: `rgb(${_manifest.palette[Math.min(v, BINS - 1)].join(",")})`, count: null }))
        : [];
      legend.push({
        label: "Biodiversity intactness: modelled share of the original species abundance remaining, 0% to 100% intact (NHM v2.1.1), ~10 km",
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The intactness bin at a point, from the finest tile of the shown snapshot; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "bii.json not loaded yet" });
      const year = shown();
      if (year === null) return row("gap", { observed: _observed });
      // the pixel under the centre of the clicked point's 5′ cell, which nearest neighbour filled from that cell; the
      // pixel under the point itself can carry the next cell (a pixel is 0.53 of a cell wide)
      const c = cellCentre(lat, lon, SOURCE_CELL);
      const t = c && geoTilePixel(c[0], c[1], _manifest.maxLevel);
      if (!t) return row("outside");
      const url = tileUrl(year).replace("{z}", String(_manifest.maxLevel)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      let pixel;
      try {
        pixel = await readTilePixel(url, t.px, t.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodePixel(pixel.rgba, _manifest.palette);
      if (v.kind === "none") return row("nodata", { date: String(year) });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("value", { text: binText(v.bin), date: String(year) });
    },
    getStats() {
      const year = shown();
      return {
        count: 1,
        lastUpdate: _lastUpdate,
        error: _lastError,
        time: year === null ? null : String(year),
        observed: _observed,
      };
    },
  };
}

export const biiLayer = createBiiLayer();
