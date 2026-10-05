import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";
import { geoTilePixel } from "./humanFootprint.js";
import { listedTilesOnly } from "./protectedAreas.js";

/**
 * Intact Forest Landscapes 2000–2025 (The IFL Mapping Team, intactforests.org, CC BY 4.0; Potapov et al. 2017, Science
 * Advances 3: e1600821): territories of at least 500 km² and 10 km wide within today's forest zone, minimally influenced
 * by human economic activity, mapped for 2000, 2013, 2016, 2020 and 2025. pipeline/ifl.py burns the five editions in
 * order into one geographic tile pyramid to level 7 (~610 m), each place coloured by the last edition it was intact in
 * (spec docs/superpowers/specs/2026-10-04-ifl-design.md). Only painted tiles exist; a tile the manifest does not list is
 * served blank without a request. A point readout decodes the class exactly from the finest tile. Editions are mapped
 * anew, so a later one can include ground the one before left out; such ground shows as the later edition, and the
 * legend gives its area. A fixed map, so not on the time bar.
 */
export const MANIFEST_URL = "data/ifl.json";
export const TILE_FAILURE_LIMIT = 8;
const TILE = 256;
const SOURCE = "Intact Forest Landscapes: The IFL Mapping Team";
export const NONE_TEXT = "not an intact forest landscape in any edition, 2000–2025";

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** null when ifl.json has the shape pipeline/ifl.py writes; otherwise what is wrong with it. */
export function validateIflManifest(m) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  if (typeof m.generated_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.generated_at)) return `generated_at ${JSON.stringify(m.generated_at)} is not a UTC time`;
  if (!Number.isInteger(m.maxLevel) || m.maxLevel < 0) return `maxLevel ${JSON.stringify(m.maxLevel)} is not a level`;
  if (typeof m.tile !== "string" || !["{z}", "{x}", "{y}"].every((k) => m.tile.includes(k))) return `tile ${JSON.stringify(m.tile)} lacks {z}, {x} or {y}`;
  if (!m.tiles || typeof m.tiles !== "object") return "tiles is not an object";
  for (let z = 0; z <= m.maxLevel; z += 1) {
    const list = m.tiles[String(z)];
    if (!Array.isArray(list)) return `tiles has no list for level ${z}`;
    for (const t of list) {
      const ok = Array.isArray(t) && t.length === 2 && Number.isInteger(t[0]) && Number.isInteger(t[1]) && t[0] >= 0 && t[0] < 2 ** (z + 1) && t[1] >= 0 && t[1] < 2 ** z;
      if (!ok) return `tile ${JSON.stringify(t)} is not on level ${z}`;
    }
  }
  const classes = m.classes;
  if (!Array.isArray(classes) || !classes.length) return "classes is not a list";
  if (classes.map((c) => c?.index).join() !== classes.map((_, i) => i + 1).join()) return "classes are not indexed 1, 2, … in order";
  if (!classes.every((c) => typeof c.label === "string" && c.label && isRgb(c.rgb))) return "every class needs a label and an RGB colour";
  if (new Set(classes.map((c) => String(c.rgb))).size !== classes.length) return "class colours are not distinct";
  const eds = m.editions;
  if (!Array.isArray(eds) || eds.length !== classes.length) return `expected ${classes.length} editions, one per class, got ${eds?.length}`;
  for (const [i, e] of eds.entries()) {
    if (!Number.isInteger(e?.year) || (i && e.year <= eds[i - 1].year)) return `edition years are not increasing at ${JSON.stringify(e?.year)}`;
    if (![e.patches, e.areaHa, e.burnedKm2, e.burnedKm2NotInPrevious].every(isCount)) return `edition ${e.year} lacks its patch, area or burned counts`;
  }
  if (m.source?.licence !== "CC BY 4.0") return `source licence ${JSON.stringify(m.source?.licence)} is not CC BY 4.0`;
  return null;
}

const tables = new WeakMap();
/** One RGBA tile pixel → a class, none (transparent), or an unrecognised colour (named, never snapped). */
export function decodeIfl(rgba, manifest) {
  let t = tables.get(manifest);
  if (!t) {
    t = new Map(manifest.classes.map((c) => [`${c.rgb.join(",")},255`, c]));
    tables.set(manifest, t);
  }
  if (rgba[3] === 0) return { kind: "none" };
  const hit = t.get(rgba.join(","));
  return hit ? { kind: "class", index: hit.index, label: hit.label } : { kind: "unknown", rgba };
}

const n = (v) => v.toLocaleString("en-US");

export function createIflLayer({
  id = "ifl",
  name = "Intact forest landscapes 2000–2025",
  icon = "🌲",
  fetchImpl = (u) => fetch(u),
  providerFor = (options) => new Cesium.UrlTemplateImageryProvider(options),
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider),
  stack = setStackedImagery,
  readTilePixel = createTilePixelReader(),
  blank,
  zrank = 21,
} = {}) {
  let _viewer = null,
    _imagery = null,
    _enabled = false,
    _manifest = null,
    _listed = null,
    _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  // the build time busts tiles cached from an earlier build, for the drape and the readout alike
  const tileUrl = () => `${_manifest.tile}?v=${_manifest.generated_at}`;
  const edition = () => `IFL ${_manifest.editions[0].year}–${_manifest.editions.at(-1).year}`;

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
    const provider = listedTilesOnly(
      providerFor({
        url: tileUrl(),
        tilingScheme: new Cesium.GeographicTilingScheme(),
        tileWidth: TILE,
        tileHeight: TILE,
        maximumLevel: _manifest.maxLevel,
        credit: SOURCE,
      }),
      _listed,
      blank, // undefined: listedTilesOnly's own blank canvas
    );
    // only listed tiles are requested, and every one was written: any tile error is a fault
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
        _lastError = `ifl.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateIflManifest(m);
      if (bad) {
        _lastError = `Malformed ifl.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      _listed = new Set(Object.entries(m.tiles).flatMap(([z, list]) => list.map(([x, y]) => `${z}/${x}/${y}`)));
      return true;
    } catch (e) {
      _lastError = `ifl.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "The IFL Mapping Team, Intact Forest Landscapes 2000–2025 (intactforests.org) · CC BY 4.0; Potapov et al. 2017",
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
      if (!_manifest) return { chips: [], legend: [] };
      const eds = _manifest.editions;
      const legend = _manifest.classes.map((c) => ({ label: c.label, color: `rgb(${c.rgb.join(",")})`, count: null }));
      const last = eds.at(-1);
      const outside = eds.reduce((s, e) => s + e.burnedKm2NotInPrevious, 0);
      legend.push({
        label: `Intact forest landscapes: at least 500 km² and 10 km wide, minimally influenced by human economic activity; colour = the last edition a place was intact in, ~610 m · ${n(last.patches)} landscapes, ${n(Math.round(last.areaHa / 100))} km² in ${last.year} · each edition is mapped anew: ${n(outside)} km² of later editions lie outside the edition before and show as the later one · The IFL Mapping Team, CC BY 4.0`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The last edition a point was intact in, from the finest tile; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "ifl.json not loaded yet" });
      const t = geoTilePixel(lat, lon, _manifest.maxLevel);
      if (!t) return row("outside");
      const date = edition();
      // an unlisted tile was never written because nothing in it was ever intact
      if (!_listed.has(`${_manifest.maxLevel}/${t.x}/${t.y}`)) return row("class", { text: NONE_TEXT, date });
      const url = tileUrl().replace("{z}", String(_manifest.maxLevel)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      let pixel;
      try {
        pixel = await readTilePixel(url, t.px, t.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeIfl(pixel.rgba, _manifest);
      if (v.kind === "none") return row("class", { text: NONE_TEXT, date });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("class", { text: v.label, date });
    },
    getStats() {
      return { count: _manifest?.editions.at(-1).patches ?? 0, lastUpdate: _lastUpdate, error: _lastError, time: _manifest ? edition() : null };
    },
  };
}

export const iflLayer = createIflLayer();
