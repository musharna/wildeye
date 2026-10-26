import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader, gibsTileRequest } from "./gibsReadout.js";

/**
 * Drivers of tree-cover loss, 2001–2025 (WRI / Google DeepMind v1.13, 1 km; Sims et al. 2025, Environ. Res. Lett.
 * 20:074027, doi:10.1088/1748-9326/add606; CC BY 4.0), drawn as served from Global Forest Watch's dynamic tiles at
 * 30% canopy and never re-hosted. Each 1 km cell carries the one driver behind most of its loss over 2001–2025, so
 * the layer is not on the time bar. GFW draws each driver in one colour (DRIVERS, copied from its renderer) with the
 * opacity of the Hansen loss under it, so at close zoom only the pixels that lost trees are coloured.
 */
export const TILE_SIZE = 512;
export const MAX_LEVEL = 12; // as hansenLoss: the opacity is the 30 m Hansen loss, so tiles gain detail to level 12
// the click reads level 12, where the drawn colour named the raw class at 210 of 210 cell centres; level 8 is drawn
// from a coarser copy and missed 4 (docs/analysis/loss_drivers_tiles_vs_raw.md, 2026-10-25)
export const READOUT_LEVEL = 12;
export const TILE_FAILURE_LIMIT = 8;
export const FIRST_YEAR = 2001;
export const LAST_YEAR = 2025;
const SOURCE = "WRI / Google DeepMind via Global Forest Watch";

export function driversTileUrl(z, x, y) {
  // without /dynamic/ every tile is a 307 to this address, which answers 422 without the threshold (probe 2026-10-25)
  return `https://tiles.globalforestwatch.org/wri_google_tree_cover_loss_drivers/v1.13/dynamic/${z}/${x}/${y}.png?implementation=default&tree_cover_density_threshold=30`;
}

// GFW's renderer, wri/gfw-tile-cache app/routes/titiler/algorithms/tree_cover_loss_drivers.py @ae9100aabc
// (conf_colors, read 2026-10-25); names from the dataset's description on the GFW data API (class 4 is "Logging"
// there, "Forest management" in the renderer's comment)
export const DRIVERS = Object.freeze([
  Object.freeze({ code: 1, rgb: Object.freeze([227, 157, 41]), name: "Permanent agriculture" }),
  Object.freeze({ code: 2, rgb: Object.freeze([229, 128, 116]), name: "Hard commodities (mining, energy)" }),
  Object.freeze({ code: 3, rgb: Object.freeze([233, 215, 0]), name: "Shifting cultivation" }),
  Object.freeze({ code: 4, rgb: Object.freeze([81, 164, 78]), name: "Logging" }),
  Object.freeze({ code: 5, rgb: Object.freeze([137, 81, 40]), name: "Wildfire" }),
  Object.freeze({ code: 6, rgb: Object.freeze([163, 84, 160]), name: "Settlements and infrastructure" }),
  Object.freeze({ code: 7, rgb: Object.freeze([58, 32, 154]), name: "Other natural disturbances" }),
]);

/**
 * One raw tile pixel → its driver, none, or an unrecognised colour (named, never snapped). The colour is read
 * whatever the alpha: alpha is the loss under the pixel, the colour is the 1 km cell's driver, and the renderer
 * leaves cells without a driver black.
 */
export function decodeDriverPixel([r, g, b, a]) {
  if (r === 0 && g === 0 && b === 0) return { kind: "none" };
  const d = DRIVERS.find((x) => x.rgb[0] === r && x.rgb[1] === g && x.rgb[2] === b);
  return d ? { kind: "driver", driver: d } : { kind: "unknown", rgba: [r, g, b, a] };
}

export function createLossDriversLayer({
  id = "loss-drivers",
  name = "Forest loss drivers (WRI/Google DeepMind, 2001–2025)",
  icon = "🚜",
  providerFor = (options) => new Cesium.UrlTemplateImageryProvider(options),
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider),
  stack = setStackedImagery,
  readTilePixel = createTilePixelReader(),
  zrank = 20,
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
    // web-mercator XYZ, the provider's default scheme; every tile exists (no loss is 200 and clear), so a tile error
    // is a fault
    const provider = providerFor({
      url: driversTileUrl("{z}", "{x}", "{y}"),
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
      maximumLevel: MAX_LEVEL,
      credit: SOURCE,
    });
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = "map tiles failing";
        console.error(`[Data:${id}] GFW tiles failing`, { error: tileError?.error ?? tileError });
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
    source: `${SOURCE} · CC BY 4.0`,
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
      else _imagery.show = _enabled;
      _lastUpdate = Date.now();
      return true;
    },
    destroy() {
      drop();
      _viewer = null;
      _enabled = false;
    },
    getRowControls() {
      const legend = DRIVERS.map((d) => ({ label: d.name, color: `rgb(${d.rgb.join(",")})`, count: null }));
      legend.push({
        label: `The driver behind most tree-cover loss in each 1 km cell, ${FIRST_YEAR}–${LAST_YEAR}, 30% canopy; fainter where less of the cell was lost (WRI/Google DeepMind v1.13) · CC BY 4.0`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The driver of the 1 km cell at a point, from a level-12 tile; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      const req = gibsTileRequest(driversTileUrl("{z}", "{x}", "{y}"), READOUT_LEVEL, lat, lon, TILE_SIZE);
      if (!req) return row("outside");
      let pixel;
      try {
        pixel = await readTilePixel(req.url, req.px, req.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url: req.url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeDriverPixel(pixel.rgba);
      const span = `${FIRST_YEAR}–${LAST_YEAR}`;
      if (v.kind === "none") return row("class", { text: "No loss driver mapped", date: span });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("class", { text: v.driver.name, date: span });
    },
    getStats() {
      return { count: 1, lastUpdate: _lastUpdate, error: _lastError, time: `${FIRST_YEAR}–${LAST_YEAR}` };
    },
  };
}

export const lossDriversLayer = createLossDriversLayer();
