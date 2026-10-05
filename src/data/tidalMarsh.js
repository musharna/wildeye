import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";
import { geoTilePixel } from "./humanFootprint.js";
import { listedTilesOnly } from "./protectedAreas.js";

/**
 * Global tidal marshes 2020, v2.6 (Worthington, Spalding, Landis, Maxwell, Navarro, Smart and Murray; Zenodo 8420753,
 * CC BY 4.0; Worthington et al. 2024, Global Ecology and Biogeography 33: e13852): a 10 m map of tidal marsh between
 * 60°N and 60°S from 2020 Earth observation data. pipeline/tidal_marsh.py counts, for every pixel of a geographic tile
 * pyramid to level 9 (~150 m), the 10 m pixels whose centre falls in it and how many of them are marsh, and paints the
 * share in whole percent (spec docs/superpowers/specs/2026-10-04-tidal-marshes-design.md). Only painted tiles exist; a
 * tile the manifest does not list is served blank without a request. A point readout decodes the share exactly from the
 * finest tile. One year, so not on the time bar.
 */
export const MANIFEST_URL = "data/tidal_marsh.json";
export const TILE_FAILURE_LIMIT = 8;
export const NONE_TEXT = "no tidal marsh mapped in this ~150 m cell";
export const MAPPED_LAT = 60;
const TILE = 256;
const SOURCE = "Global tidal marshes 2020: Worthington et al.";

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);

/** null when tidal_marsh.json has the shape pipeline/tidal_marsh.py writes; otherwise what is wrong with it. */
export function validateTidalMarshManifest(m) {
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
  const p = m.palette;
  if (!Array.isArray(p) || p.length !== 101 || !p.every(isRgb)) return "palette is not 101 RGB colours";
  if (new Set(p.slice(1).map(String)).size !== 100) return "palette shares 1–100% are not distinct colours";
  if (m.year !== 2020) return `year ${JSON.stringify(m.year)} is not 2020`;
  if (typeof m.version !== "string" || !m.version) return "version is missing";
  if (!Number.isInteger(m.members) || m.members < 1) return `members ${JSON.stringify(m.members)} is not a count`;
  if (typeof m.marshKm2 !== "number" || !(m.marshKm2 > 0)) return `marshKm2 ${JSON.stringify(m.marshKm2)} is not an area`;
  if (m.source?.licence !== "CC BY 4.0") return `source licence ${JSON.stringify(m.source?.licence)} is not CC BY 4.0`;
  return null;
}

const tables = new WeakMap();
/** One RGBA tile pixel → a share in whole percent, none (transparent), or an unrecognised colour (named, never snapped). */
export function decodeTidalMarsh(rgba, manifest) {
  let t = tables.get(manifest);
  if (!t) {
    t = new Map(manifest.palette.map((c, i) => [`${c.join(",")},255`, i]).filter(([, i]) => i > 0));
    tables.set(manifest, t);
  }
  if (rgba[3] === 0) return { kind: "none" };
  const share = t.get(rgba.join(","));
  return share ? { kind: "share", share } : { kind: "unknown", rgba };
}

/** Readout text for a share: 1 is painted for any share under 1.5%, so it says so. */
export function shareText(share) {
  return share === 1 ? "tidal marsh: under 1.5% of the ~150 m cell" : `tidal marsh: about ${share}% of the ~150 m cell`;
}

// legend bins: each swatch is the colour of its middle share
export const LEGEND_BINS = [
  [1, 10],
  [10, 25],
  [25, 50],
  [50, 75],
  [75, 100],
];

const n = (v) => Math.round(v).toLocaleString("en-US");

export function createTidalMarshLayer({
  id = "tidal-marsh",
  name = "Tidal marshes 2020",
  icon = "🌾",
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
  const edition = () => `${_manifest.year} (v${_manifest.version})`;

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
        _lastError = `tidal_marsh.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateTidalMarshManifest(m);
      if (bad) {
        _lastError = `Malformed tidal_marsh.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      _listed = new Set(Object.entries(m.tiles).flatMap(([z, list]) => list.map(([x, y]) => `${z}/${x}/${y}`)));
      return true;
    } catch (e) {
      _lastError = `tidal_marsh.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "Worthington et al., Global tidal marshes 2020 v2.6 (Zenodo 8420753) · CC BY 4.0",
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
      const p = _manifest.palette;
      const legend = LEGEND_BINS.map(([lo, hi]) => ({
        label: `${lo}–${hi}% marsh`,
        color: `rgb(${p[Math.round((lo + hi) / 2)].join(",")})`,
        count: null,
      }));
      legend.push({
        label: `Share of each ~150 m cell mapped as tidal marsh in 2020, from a 10 m map of 60°N–60°S (overall accuracy 0.85) · ${n(_manifest.marshKm2)} km² mapped; the authors' area estimate is 52,880 km² (95% CI 32,030–59,780) · Worthington et al. 2024, CC BY 4.0`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The marsh share of the ~150 m cell at a point, from the finest tile; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "tidal_marsh.json not loaded yet" });
      if (Math.abs(lat) > MAPPED_LAT) return row("outside");
      const t = geoTilePixel(lat, lon, _manifest.maxLevel);
      if (!t) return row("outside");
      const date = edition();
      // an unlisted tile was never written because no marsh is mapped in it
      if (!_listed.has(`${_manifest.maxLevel}/${t.x}/${t.y}`)) return row("class", { text: NONE_TEXT, date });
      const url = tileUrl().replace("{z}", String(_manifest.maxLevel)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      let pixel;
      try {
        pixel = await readTilePixel(url, t.px, t.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeTidalMarsh(pixel.rgba, _manifest);
      if (v.kind === "none") return row("class", { text: NONE_TEXT, date });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("class", { text: shareText(v.share), date });
    },
    getStats() {
      return { count: _manifest ? 1 : 0, lastUpdate: _lastUpdate, error: _lastError, time: _manifest ? edition() : null };
    },
  };
}

export const tidalMarshLayer = createTidalMarshLayer();
