import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader, gibsTileRequest } from "./gibsReadout.js";

/**
 * Surface water occurrence, 1984–2021 (EC JRC Global Surface Water; Pekel et al. 2016, Nature 540:418–422,
 * doi:10.1038/nature20584): the share of months water was seen at each 30 m pixel. Drawn straight from JRC's
 * own tiles; a point readout decodes the percent exactly (spec docs/superpowers/specs/2026-10-01-surface-water-design.md).
 * A fixed product, so not on the time bar.
 */
export const SURFACE_WATER_URL = "https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png";
export const MAX_LEVEL = 13; // z14 is 404 over land (probe 2026-10-01)
export const TILE_FAILURE_LIMIT = 8;
export const PERIOD = "1984–2021";
const SOURCE = "Source: EC JRC/Google";

/**
 * The tile colour of k% occurrence (k = 1–100): red fading to blue, alpha rising with k. The 100 colours the tiles
 * carry (14 places at z13, 456,433 water pixels) are this formula except at 80%, where the encoder's own rounding
 * gives R = 50.
 */
export function occurrenceColour(k) {
  if (!(Number.isInteger(k) && k >= 1 && k <= 100)) throw new RangeError(`occurrence must be an integer 1–100, got ${k}`);
  const r = k === 80 ? 50 : Math.floor((25500 - 255 * k) / 100);
  return [r, 0, Math.floor((255 * k) / 100), Math.floor((510 * k + 100) / 200)];
}

const PERCENT_OF = new Map(Array.from({ length: 100 }, (_, i) => [occurrenceColour(i + 1).join(","), i + 1]));

/** One RGBA tile pixel → no water, a percent, or an unrecognised colour (named, never snapped). */
export function decodeOccurrence(rgba) {
  if (rgba[3] === 0) return { kind: "none" };
  const percent = PERCENT_OF.get(rgba.join(","));
  return percent ? { kind: "value", percent } : { kind: "unknown", rgba };
}

export function createSurfaceWaterLayer({
  id = "surface-water",
  name = `Surface water (JRC, ${PERIOD})`,
  icon = "💧",
  providerFor = (options) => new Cesium.UrlTemplateImageryProvider(options),
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider),
  stack = setStackedImagery,
  readTilePixel = createTilePixelReader(),
  zrank = 21,
} = {}) {
  let _viewer = null,
    _imagery = null,
    _enabled = false,
    _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, id, null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
  };

  const draw = () => {
    drop();
    _generation += 1;
    _tileFailures = 0;
    _lastError = null;
    const generation = _generation;
    const provider = providerFor({ url: SURFACE_WATER_URL, maximumLevel: MAX_LEVEL, credit: SOURCE });
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = "map tiles failing";
        console.error(`[Data:${id}] JRC tiles failing`, { error: tileError?.error ?? tileError });
      }
    });
    _imagery = imageryLayerFor(provider);
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
  };

  return {
    id,
    name,
    icon,
    source: `EC JRC/Google Global Surface Water · free, without restriction of use`,
    updateInterval: 24 * 3600000,
    init(viewer) {
      _viewer = viewer;
    },
    enable() {
      _enabled = true;
      if (_imagery) _imagery.show = true;
    },
    disable() {
      _enabled = false;
      if (_imagery) _imagery.show = false;
    },
    async update() {
      if (!_viewer) return false;
      // Cesium never re-requests a failed tile; a fresh provider is the retry
      if (!_imagery || _lastError === "map tiles failing") draw();
      _lastUpdate = Date.now();
      return true;
    },
    destroy() {
      drop();
      _viewer = null;
      _enabled = false;
    },
    getRowControls() {
      const legend = [10, 25, 50, 75, 100].map((k) => {
        const [r, g, b, a] = occurrenceColour(k);
        return { label: `${k}%`, color: `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`, count: null };
      });
      legend.push({ label: `Share of months with water, ${PERIOD} (EC JRC/Google)`, color: "transparent", count: null });
      return { chips: [], legend };
    },
    /** The occurrence at a point, from the full-resolution tile (z13); null when off. A 404 tile is outside the data. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      const req = gibsTileRequest(SURFACE_WATER_URL, MAX_LEVEL, lat, lon);
      if (!req) return row("outside");
      let pixel;
      try {
        pixel = await readTilePixel(req.url, req.px, req.py);
      } catch (e) {
        if (e?.status === 404) return row("outside");
        console.error(`[Data:${id}] readout failed`, { lat, lon, url: req.url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeOccurrence(pixel.rgba);
      if (v.kind === "none") return row("class", { text: "No surface water seen", date: PERIOD });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("value", { text: `Water in ${v.percent}% of months`, date: PERIOD });
    },
    getStats() {
      return {
        count: 1,
        lastUpdate: _lastUpdate,
        error: _lastError,
        time: PERIOD,
      };
    },
  };
}

export const surfaceWaterLayer = createSurfaceWaterLayer();
