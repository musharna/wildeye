import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";
import { geoTilePixel } from "./humanFootprint.js";
import { cellCentre } from "./mammals.js";

/**
 * Modelled soil bacterial richness (Bickel et al. 2026, ISME Communications, doi:10.1093/ismeco/ycag266; maps Zenodo
 * 10.5281/zenodo.21133869, CC BY 4.0): bacterial 16S rRNA sequence variants found in 7,500 sequencing reads of one soil
 * sample, as predicted by a model of ten environmental variables fitted at 320 sampled locations (held-out R² 0.41).
 * pipeline/soil_bacteria.py turns the model's 0.1° mean into a geographic tile pyramid binned in tens (spec
 * docs/superpowers/specs/2026-10-07-soil-bacteria-design.md), plus level-3 RGBA value tiles carrying each cell's whole
 * mean and the model ensemble's spread (SD). A point readout decodes both exactly. Nothing varies with time.
 */
export const MANIFEST_URL = "data/soil_bacteria.json";
export const TILE_FAILURE_LIMIT = 8;
export const NONE_TEXT = "No modelled soil estimate";
export const DATE = "Bickel et al. 2026 model";
export const LEGEND_STOPS = [200, 400, 600, 800];
const TILE = 256;
const ENCODE_MAX = 4095; // 12 bits each (pipeline/soil_bacteria.py ENCODE_MAX)
const SOURCE = "Soil bacterial richness: model of Bickel et al. 2026";

const isPair = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 0 && n <= ENCODE_MAX) && v[0] <= v[1];

/** null when soil_bacteria.json has the shape pipeline/soil_bacteria.py writes; otherwise what is wrong with it. */
export function validateManifest(m) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  const { maxLevel, tile, valueTile, palette, display, model } = m;
  if (typeof m.generated_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.generated_at)) return `generated_at ${JSON.stringify(m.generated_at)} is not a UTC time`;
  if (!Number.isInteger(maxLevel) || maxLevel < 0) return `maxLevel ${JSON.stringify(maxLevel)} is not a level`;
  if (typeof tile !== "string" || !["{z}", "{x}", "{y}"].every((k) => tile.includes(k)))
    return `tile ${JSON.stringify(tile)} lacks {z}, {x} or {y}`;
  if (typeof valueTile !== "string" || !["{x}", "{y}"].every((k) => valueTile.includes(k)))
    return `valueTile ${JSON.stringify(valueTile)} lacks {x} or {y}`;
  if (!display || ![display.min, display.max, display.step].every(Number.isInteger) || display.step < 1 || display.max <= display.min || (display.max - display.min) % display.step)
    return `display ${JSON.stringify(display)} is not whole bins from min to max`;
  const bins = (display.max - display.min) / display.step;
  if (!Array.isArray(palette) || palette.length !== bins + 1 || !palette.every((c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)))
    return `palette is not ${bins + 1} RGB colours`;
  if (new Set(palette.slice(1).map(String)).size !== bins) return "palette colours are not distinct";
  if (!isPair(m.mean) || !isPair(m.sd)) return `mean ${JSON.stringify(m.mean)} or sd ${JSON.stringify(m.sd)} is not a range 0–${ENCODE_MAX}`;
  if (!model || !(model.r2 > 0 && model.r2 < 1) || !Number.isInteger(model.locations) || !Number.isInteger(model.reads))
    return `model ${JSON.stringify(model)} lacks r2, locations or reads`;
  return null;
}

/** One value-tile pixel → the cell's whole mean and SD, none (all zero), or an unknown pixel (named, never guessed). */
export function decodeValue([r, g, b, a]) {
  if (a === 0 && r === 0 && g === 0 && b === 0) return { kind: "none" };
  if (a !== 255) return { kind: "unknown", rgba: [r, g, b, a] };
  return { kind: "value", mean: r + 256 * (b % 16), sd: g + 256 * Math.floor(b / 16) };
}

/** The readout line. */
export function valueText(mean, sd) {
  return `≈${mean.toLocaleString("en-US")} bacterial sequence variants per soil sample (model spread ±${sd.toLocaleString("en-US")})`;
}

/** The palette index of the display bin holding a value (pipeline/soil_bacteria.py bins). */
export function binOf(v, { min, max, step }) {
  return Math.min(Math.max(1 + Math.floor((v - min) / step), 1), (max - min) / step);
}

export function createSoilBacteriaLayer({
  id = "soil-bacteria",
  name = "Soil bacterial richness (model)",
  icon = "🦠",
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
    _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  // the build time busts tiles cached from an earlier build, for the drape and the readout alike
  const bust = (url) => `${url}?v=${_manifest.generated_at}`;

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
    const provider = providerFor({
      url: bust(_manifest.tile),
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
        console.error(`[Data:${id}] tiles failing`, { error: tileError?.error ?? tileError });
      }
    });
    _imagery = imageryLayerFor(provider);
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
  };

  const load = async () => {
    try {
      const res = await fetchImpl(MANIFEST_URL);
      if (!res.ok) {
        _lastError = `soil_bacteria.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateManifest(m);
      if (bad) {
        _lastError = `Malformed soil_bacteria.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      return true;
    } catch (e) {
      _lastError = `soil_bacteria.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "Bickel et al. 2026, ISME Communications; maps Zenodo 10.5281/zenodo.21133869 · CC BY 4.0",
    updateInterval: 24 * 3600000, // static tiles
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
      if (!_manifest && !(await load())) return false;
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
      const legend = _manifest
        ? LEGEND_STOPS.map((v) => ({ label: `${v}`, color: `rgb(${_manifest.palette[binOf(v, _manifest.display)].join(",")})`, count: null }))
        : [];
      const md = _manifest?.model ?? { r2: 0.41, locations: 320, reads: 7500 };
      legend.push({
        label:
          `Modelled soil bacterial richness: bacterial 16S rRNA sequence variants per soil sample, counted in ${md.reads.toLocaleString("en-US")} ` +
          `sequencing reads, 0.1° cells. A model of ten environmental variables fitted at ${md.locations} sampled locations ` +
          `(held-out R² ${md.r2.toFixed(2)}): a prediction, not a survey. Values over Greenland's ice sheet are model extrapolation ` +
          `with no soil samples behind them (Antarctica is blank) · Bickel et al. 2026, CC BY 4.0`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The cell's modelled mean and model spread at a point, from the level-3 value tile; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "soil_bacteria.json not loaded yet" });
      const z = _manifest.maxLevel;
      // the pixel under the centre of the clicked point's 0.1° cell, which holds that cell's values
      const c = cellCentre(lat, lon);
      const t = c && geoTilePixel(c[0], c[1], z);
      if (!t) return row("outside");
      const url = bust(_manifest.valueTile.replace("{z}", String(z)).replace("{x}", String(t.x)).replace("{y}", String(t.y)));
      try {
        const v = decodeValue((await readTilePixel(url, t.px, t.py)).rgba);
        if (v.kind === "none") return row("class", { text: NONE_TEXT, date: DATE });
        if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
        const [m0, m1] = _manifest.mean, [s0, s1] = _manifest.sd;
        if (v.mean < m0 || v.mean > m1 || v.sd < s0 || v.sd > s1)
          return row("error", { error: `pixel decodes to mean ${v.mean}, SD ${v.sd}: outside the build's ${m0}–${m1}, ${s0}–${s1}` });
        return row("value", { text: valueText(v.mean, v.sd), date: DATE });
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, error: e });
        return row("error", { error: e?.message || String(e) });
      }
    },
    getStats() {
      return { count: _manifest ? 1 : 0, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}

export const soilBacteriaLayer = createSoilBacteriaLayer();
