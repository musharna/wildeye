import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";
import { geoTilePixel } from "./humanFootprint.js";

/**
 * Wetlands, GLWD v2 (Lehner et al. 2025, Earth System Science Data 17:2277–2329, doi:10.5194/essd-17-2277-2025;
 * figshare 28519994, CC BY 4.0): the dominant of 33 wetland types where wetland covers more than half the cell, cut by
 * pipeline/glwd.py into a geographic tile pyramid to level 6 (~1.2 km), mode of the 500 m cells with the sea excluded
 * (spec docs/superpowers/specs/2026-10-01-wetlands-design.md). A point readout decodes the type exactly from the finest
 * tile and names it in GLWD's own words. A fixed map, so not on the time bar.
 */
export const MANIFEST_URL = "data/glwd.json";
export const TILE_FAILURE_LIMIT = 8;
const TILE = 256;
const SOURCE = "GLWD v2: Lehner et al. 2025";
const EDITION = "GLWD v2";

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);

/** null when glwd.json has the shape pipeline/glwd.py writes; otherwise what is wrong with it. */
export function validateWetlandsManifest(m) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  if (!Number.isInteger(m.maxLevel) || m.maxLevel < 0) return `maxLevel ${JSON.stringify(m.maxLevel)} is not a level`;
  if (typeof m.tile !== "string" || !["{z}", "{x}", "{y}"].every((k) => m.tile.includes(k)))
    return `tile ${JSON.stringify(m.tile)} lacks {z}, {x} or {y}`;
  if (!isRgb(m.dryland) || !isRgb(m.noData)) return "dryland and noData are not RGB colours"; // told apart by the distinct check below
  const classes = m.classes;
  if (!Array.isArray(classes) || classes.length !== 33) return `expected 33 classes, got ${classes?.length}`;
  if (classes.map((c) => c?.id).join() !== Array.from({ length: 33 }, (_, i) => i + 1).join()) return "classes are not ids 1–33 in order";
  if (!classes.every((c) => typeof c.name === "string" && c.name && typeof c.family === "string" && isRgb(c.rgb)))
    return "every class needs a name, a family and an RGB colour";
  const colours = new Set([...classes.map((c) => String(c.rgb)), String(m.dryland), String(m.noData)]);
  if (colours.size !== 35) return "class colours are not distinct from each other and from dryland and noData";
  if (!Array.isArray(m.families) || !m.families.length || !m.families.every((f) => typeof f?.name === "string" && isRgb(f.rgb)))
    return "families is not a list of named colours";
  return null;
}

const tables = new WeakMap();
/** One RGBA tile pixel → a class, dryland, no data, or an unrecognised colour (named, never snapped). */
export function decodeWetland(rgba, manifest) {
  let t = tables.get(manifest);
  if (!t) {
    t = new Map(manifest.classes.map((c) => [`${c.rgb.join(",")},255`, c]));
    t.set(`${manifest.dryland.join(",")},0`, "dryland");
    t.set(`${manifest.noData.join(",")},0`, "nodata");
    tables.set(manifest, t);
  }
  const hit = t.get(rgba.join(","));
  if (hit === "dryland" || hit === "nodata") return { kind: hit };
  if (hit) return { kind: "class", id: hit.id, name: hit.name, family: hit.family };
  return { kind: "unknown", rgba };
}

export function createWetlandsLayer({
  id = "wetlands",
  name = "Wetlands (GLWD v2, Lehner et al. 2025)",
  icon = "🌾",
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
      url: _manifest.tile,
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
        _lastError = `glwd.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateWetlandsManifest(m);
      if (bad) {
        _lastError = `Malformed glwd.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      return true;
    } catch (e) {
      _lastError = `glwd.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "Lehner et al. 2025, Global Lakes and Wetlands Database v2 (figshare) · CC BY 4.0",
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
      if (!_manifest && !(await load())) return false;
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
      const legend = (_manifest?.families ?? []).map((f) => ({ label: f.name, color: `rgb(${f.rgb.join(",")})`, count: null }));
      legend.push({ label: "Dominant wetland type where a cell is mostly wetland (GLWD v2, Lehner et al. 2025), ~1.2 km", color: "transparent", count: null });
      return { chips: [], legend };
    },
    /** The wetland type at a point, from the finest tile; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "glwd.json not loaded yet" });
      const t = geoTilePixel(lat, lon, _manifest.maxLevel);
      if (!t) return row("outside");
      const url = _manifest.tile.replace("{z}", String(_manifest.maxLevel)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      let pixel;
      try {
        pixel = await readTilePixel(url, t.px, t.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeWetland(pixel.rgba, _manifest);
      if (v.kind === "nodata") return row("nodata", { date: EDITION });
      if (v.kind === "dryland") return row("class", { text: "Mostly dryland", date: EDITION });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("class", { text: v.name, date: EDITION });
    },
    getStats() {
      return { count: 1, lastUpdate: _lastUpdate, error: _lastError, time: EDITION };
    },
  };
}

export const wetlandsLayer = createWetlandsLayer();
