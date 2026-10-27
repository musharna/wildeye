import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader, tilePixel } from "./gibsReadout.js";

/**
 * Land cover at 10 m, one map a year 2017–2025 (Impact Observatory, Microsoft and Esri; Karra et al. 2021, IGARSS
 * 4704–4707, doi:10.1109/IGARSS47720.2021.9553499), drawn live from Esri's image service: it has no tile cache, so
 * each tile is an exportImage of the tile's web-mercator box for the year, in the service's own nine colours, and
 * nothing is re-hosted (grill_wildeye_esri_lulc_2026-10-26). On the time bar: the year shown is the year scrubbed
 * to, the newest year when live or later. A point readout decodes the pixel of the finest tile, the same request
 * the drape made, against the published palette (exportImage is nearest-neighbour, so every opaque pixel is one
 * class); the service's getSamples is not used because a point with no data and a bad request both answer 400.
 */
export const FIRST_YEAR = 2017;
export const LAST_YEAR = 2025;
export const TILE_SIZE = 256;
export const MAX_LEVEL = 14; // 256 px at z14 ≈ 9.6 m at the equator, the data's 10 m
export const TILE_FAILURE_LIMIT = 8;
export const SERVICE =
  "https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer";
const SOURCE = "Impact Observatory, Microsoft and Esri";
// The service's legend for its Cartographic Renderer, read 2026-10-26 (value = the class code in the raster)
export const CLASSES = Object.freeze([
  { value: 1, label: "Water", rgb: [26, 91, 171] },
  { value: 2, label: "Trees", rgb: [53, 130, 33] },
  { value: 4, label: "Flooded vegetation", rgb: [135, 209, 158] },
  { value: 5, label: "Crops", rgb: [255, 219, 92] },
  { value: 7, label: "Built area", rgb: [237, 2, 42] },
  { value: 8, label: "Bare ground", rgb: [237, 233, 228] },
  { value: 9, label: "Snow or ice", rgb: [242, 250, 255] },
  { value: 10, label: "Clouds (no clear view that year)", rgb: [200, 200, 200] },
  { value: 11, label: "Rangeland", rgb: [239, 207, 168] },
]);
export const NONE_TEXT = "No land cover here (sea, or no data)";
const BY_RGB = new Map(CLASSES.map((c) => [c.rgb.join(","), c]));
const HALF = Math.PI * 6378137; // web-mercator half-width, m

/** The year drawn for a time-bar instant: null before 2017 (nothing to draw), the newest year when live or later. */
export function yearFor(iso) {
  if (!iso) return LAST_YEAR;
  const y = new Date(iso).getUTCFullYear();
  if (!Number.isFinite(y)) throw new Error(`land cover: not a date: ${iso}`);
  if (y < FIRST_YEAR) return null;
  return Math.min(y, LAST_YEAR);
}

/** The tile's web-mercator box [west, south, east, north] in metres (EPSG:3857), as Cesium's WebMercatorTilingScheme cuts it. */
export function tileBox(z, x, y) {
  const size = (2 * HALF) / 2 ** z;
  return [-HALF + x * size, HALF - (y + 1) * size, -HALF + (x + 1) * size, HALF - y * size];
}

export function lulcTileUrl(z, x, y, year) {
  const time = Date.UTC(year, 6, 1); // mid-year: inside the one raster tagged with that Year
  // No renderingRule: the service's default draws its Cartographic Renderer pixel for pixel (checked 2026-10-26 on
  // 192 sampled level-14 tiles and at zooms 1, 5, 9 and 14 in docs/analysis/esri_lulc_drawn_vs_source.md), and a JSON rule cannot get through Cesium, whose
  // Resource turns %7B/%7D back into braces that the service refuses with a 400 and no CORS header. A changed
  // default would read as an unrecognised colour, never as a wrong class: decodeLulcPixel does not snap.
  return (
    `${SERVICE}/exportImage?bbox=${tileBox(z, x, y).join(",")}&bboxSR=3857&imageSR=3857` +
    `&size=${TILE_SIZE},${TILE_SIZE}&format=png32&time=${time}&f=image`
  );
}

/** One tile pixel → a class, none (transparent) or an unrecognised colour (named, never snapped). */
export function decodeLulcPixel(rgba) {
  if (rgba[3] === 0) return { kind: "none" };
  const c = rgba[3] === 255 ? BY_RGB.get(rgba.slice(0, 3).join(",")) : undefined;
  return c ? { kind: "class", ...c } : { kind: "unknown", rgba };
}

export function createEsriLulcLayer({
  id = "esri-lulc",
  name = "Land cover 10 m (Esri/Impact Observatory, yearly)",
  icon = "🧭",
  providerFor = (requestImage) => {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: `${SERVICE}/exportImage`,
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
      maximumLevel: MAX_LEVEL,
      credit: SOURCE,
    });
    provider.requestImage = requestImage;
    return provider;
  },
  loadImage = (provider, url) => Cesium.ImageryProvider.loadImage(provider, url),
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider),
  stack = setStackedImagery,
  readTilePixel = createTilePixelReader(),
  zrank = 14,
} = {}) {
  let _viewer = null,
    _imagery = null,
    _drawnYear = null,
    _enabled = false,
    _observed = null,
    _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, id, null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
    _drawnYear = null;
  };

  const draw = (year) => {
    if (year === _drawnYear && _imagery) {
      _imagery.show = _enabled;
      return;
    }
    drop();
    _generation += 1;
    _tileFailures = 0;
    if (_lastError === "map tiles failing") _lastError = null;
    const generation = _generation;
    const provider = providerFor((x, y, level) => loadImage(provider, lulcTileUrl(level, x, y, year)));
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = "map tiles failing";
        console.error(`[Data:${id}] Esri land cover tiles failing`, { year, error: tileError?.error ?? tileError });
      }
    });
    _imagery = imageryLayerFor(provider);
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
    _drawnYear = year;
  };

  const apply = () => {
    const year = yearFor(_observed);
    if (year === null) {
      if (_imagery) _imagery.show = false;
      _lastError = `no land cover is mapped before ${FIRST_YEAR} (shown: ${String(_observed).slice(0, 10)})`;
      return;
    }
    if (_lastError?.startsWith("no land cover")) _lastError = null;
    draw(year);
  };

  return {
    id,
    name,
    icon,
    source: `${SOURCE} via Esri · data CC BY 4.0`,
    updateInterval: 24 * 3600000,
    init(viewer) {
      _viewer = viewer;
    },
    enable() {
      _enabled = true;
      if (_imagery) _imagery.show = yearFor(_observed) !== null;
    },
    disable() {
      _enabled = false;
      if (_imagery) _imagery.show = false;
    },
    async update() {
      if (!_viewer) return false;
      // Cesium never re-requests a failed tile; a fresh provider is the retry
      if (_lastError === "map tiles failing") drop();
      apply();
      _lastUpdate = Date.now();
      return true;
    },
    async setObservedTime(iso) {
      _observed = iso || null;
      if (_viewer) apply();
      return true;
    },
    getObservedExtent() {
      return { startMs: Date.UTC(FIRST_YEAR, 0, 1), endMs: Date.UTC(LAST_YEAR, 11, 31, 23) };
    },
    destroy() {
      drop();
      _viewer = null;
      _enabled = false;
      _observed = null;
    },
    getRowControls() {
      const legend = CLASSES.map((c) => ({ label: c.label, color: `rgb(${c.rgb.join(",")})`, count: null }));
      legend.push({
        label: `One map a year ${FIRST_YEAR}–${LAST_YEAR} from Sentinel-2 at 10 m, the year on the time bar (the newest when live); zoomed out, each pixel is one 10 m sample, not the most common class · Impact Observatory, Microsoft, Esri; data CC BY 4.0`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The class at a point, from the finest tile of the year shown; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      const year = yearFor(_observed);
      if (year === null) return row("outside");
      const t = tilePixel(lat, lon, MAX_LEVEL, TILE_SIZE);
      if (!t) return row("outside");
      const url = lulcTileUrl(MAX_LEVEL, t.x, t.y, year);
      let pixel;
      try {
        pixel = await readTilePixel(url, t.px, t.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeLulcPixel(pixel.rgba);
      if (v.kind === "none") return row("class", { text: NONE_TEXT, date: String(year) });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("class", { text: v.label, date: String(year) });
    },
    getStats() {
      const year = yearFor(_observed);
      return { count: 1, lastUpdate: _lastUpdate, error: _lastError, time: year === null ? null : String(year), observed: _observed };
    },
  };
}

export const esriLulcLayer = createEsriLulcLayer();
