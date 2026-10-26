import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";
import { geoTilePixel } from "./humanFootprint.js";
import { listedTilesOnly } from "./protectedAreas.js";

/**
 * Land change 2025 from the AlphaEarth Foundations Satellite Embedding v1 (Google, Google DeepMind; CC BY 4.0): one
 * 64-number summary of each 10 m pixel's year of satellite data, 2017-2025. pipeline/aef_change.py reads the 1.28 km
 * overview and scores how unlike the three years before it 2025 is, against how unlike its own recent years usually
 * are (frozen by the pilot, docs/analysis/aef-change-pilot.md), and paints a geographic tile pyramid to level 6 in four
 * bands above the threshold; a coarser pixel is painted where a quarter of its scored area is flagged. Only painted
 * tiles exist; a tile the manifest does not list is served blank without a request. A point readout decodes the band
 * from the finest tile. One fixed comparison, so not on the time bar.
 */
export const MANIFEST_URL = "data/aef_change.json";
export const TILE_FAILURE_LIMIT = 8;
export const ATTRIBUTION = "The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.";
const TILE = 256;
const SOURCE = "AlphaEarth Foundations: Google, Google DeepMind";
export const NONE_TEXT = "no unusual change, or no score here (desert, Antarctica, no data, a UTM zone edge, or a year missing)";
export const NOTE =
  "Where 2025 looks unlike any of the three years before it, more than is usual for that place and for the rest of its 82 km tile, over ~1.3 km cells; zoomed out, a pixel is coloured where a quarter of it changed · not only forest loss: also fires, floods, building, crop changes, wide rivers whose water or ice changed and region-wide weather swings · deserts and Antarctica are not drawn: there the source shifts between processing runs more than the land does · on test tiles it found 7–65% of 2025 forest loss (least for large boreal fires) and flagged 0.4% of untouched forest · Google, Google DeepMind, CC BY 4.0";

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** null when aef_change.json has the shape pipeline/aef_change.py writes; otherwise what is wrong with it. */
export function validateAefChangeManifest(m) {
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
  if (!classes.every((c, i) => Number.isFinite(c.min) && (i === 0 || c.min > classes[i - 1].min))) return "class score edges do not rise";
  const noArea = classes.find((c) => !isCount(c.km2));
  if (noArea) return `class ${noArea.label} lacks its area`;
  if (!isCount(m.locations) || !isCount(m.locationsScored) || m.locationsScored > m.locations) return `${m.locationsScored} locations scored of ${m.locations}`;
  if (m.source?.licence !== "CC BY 4.0") return `source licence ${JSON.stringify(m.source?.licence)} is not CC BY 4.0`;
  if (m.source?.attribution !== ATTRIBUTION) return "source attribution is not the dataset's required text";
  return null;
}

const tables = new WeakMap();
/** One RGBA tile pixel → a band, none (transparent), or an unrecognised colour (named, never snapped). */
export function decodeAefChange(rgba, manifest) {
  let t = tables.get(manifest);
  if (!t) {
    t = new Map(manifest.classes.map((c) => [`${c.rgb.join(",")},255`, c]));
    tables.set(manifest, t);
  }
  if (rgba[3] === 0) return { kind: "none" };
  const hit = t.get(rgba.join(","));
  return hit ? { kind: "class", index: hit.index, label: hit.label, min: hit.min, max: manifest.classes[hit.index]?.min ?? null } : { kind: "unknown", rgba };
}

const n = (v) => v.toLocaleString("en-US");
const DATE = "2025 vs 2022–24";

export function createAefChangeLayer({
  id = "aef-change",
  name = "Land change 2025",
  icon = "🛰️",
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
        _lastError = `aef_change.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateAefChangeManifest(m);
      if (bad) {
        _lastError = `Malformed aef_change.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      _listed = new Set(Object.entries(m.tiles).flatMap(([z, list]) => list.map(([x, y]) => `${z}/${x}/${y}`)));
      return true;
    } catch (e) {
      _lastError = `aef_change.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "Google, Google DeepMind, AlphaEarth Foundations Satellite Embedding v1 · CC BY 4.0",
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
      const legend = _manifest.classes.map((c) => ({ label: `${c.label}, ${n(c.km2)} km²`, color: `rgb(${c.rgb.join(",")})`, count: null }));
      legend.push({ label: NOTE, color: "transparent", count: null });
      return { chips: [], legend };
    },
    /** The change band at a point, from the finest tile; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "aef_change.json not loaded yet" });
      const t = geoTilePixel(lat, lon, _manifest.maxLevel);
      if (!t) return row("outside");
      // an unlisted tile was never written because nothing in it was flagged
      if (!_listed.has(`${_manifest.maxLevel}/${t.x}/${t.y}`)) return row("class", { text: NONE_TEXT, date: DATE });
      const url = tileUrl().replace("{z}", String(_manifest.maxLevel)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      let pixel;
      try {
        pixel = await readTilePixel(url, t.px, t.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeAefChange(pixel.rgba, _manifest);
      if (v.kind === "none") return row("class", { text: NONE_TEXT, date: DATE });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("class", { text: `${v.label} (score ${v.max === null ? `${v.min} or more` : `${v.min} to ${v.max}`})`, date: DATE });
    },
    getStats() {
      return { count: _manifest?.tiles[String(_manifest.maxLevel)].length ?? 0, lastUpdate: _lastUpdate, error: _lastError, time: _manifest ? DATE : null };
    },
  };
}

export const aefChangeLayer = createAefChangeLayer();
