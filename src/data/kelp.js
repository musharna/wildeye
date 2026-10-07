import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";
import { geoTilePixel } from "./humanFootprint.js";
import { listedTilesOnly } from "./protectedAreas.js";
import { decodeTidalMarsh as decodeShare, LEGEND_BINS } from "./tidalMarsh.js";

/**
 * Global floating kelp forests (Arafeh-Dalmau, Villaseñor-Derbez, Schoeman, Mora-Soto, Bell et al.; Zenodo 14816612,
 * CC BY 4.0; Nature Communications 16:3173, 2025, doi:10.1038/s41467-025-58054-4): 426,489 polygons, every satellite pixel
 * where floating kelp canopy was ever detected (Landsat 1984 onward where regional maps exist, a Sentinel-2 mosaic of
 * 2015–2019 elsewhere). pipeline/kelp.py burns them onto a 64 × 64 subgrid of every pixel of a geographic tile pyramid
 * to level 9 (~150 m) and paints the share of the cell in whole percent (spec
 * docs/superpowers/specs/2026-10-07-kelp-forests-design.md). Only painted tiles exist; a tile the manifest does not list
 * is served blank without a request. A point readout decodes the share exactly from the finest tile. A union over the
 * whole record, so not on the time bar.
 */
export const MANIFEST_URL = "data/kelp.json";
export const TILE_FAILURE_LIMIT = 8;
export const NONE_TEXT = "no floating kelp mapped in this ~150 m cell";
export const EDITION = "ever detected, 1984 on (map of Feb 2024)";
// the paper's Source Data (sheet "Figure 4, Figure S1, S4", kelp_area_km2 summed): 2,216.55 km²
export const PAPER_KM2 = 2216.55;
const TILE = 256;
const SOURCE = "Global floating kelp forests: Arafeh-Dalmau et al. 2025";

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);

/** null when kelp.json has the shape pipeline/kelp.py writes; otherwise what is wrong with it. */
export function validateKelpManifest(m) {
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
  if (!Number.isInteger(m.subpixels) || m.subpixels < 1) return `subpixels ${JSON.stringify(m.subpixels)} is not a count`;
  if (!Number.isInteger(m.features) || m.features < 1) return `features ${JSON.stringify(m.features)} is not a count`;
  if (typeof m.kelpKm2 !== "number" || !(m.kelpKm2 > 0)) return `kelpKm2 ${JSON.stringify(m.kelpKm2)} is not an area`;
  if (m.source?.licence !== "CC BY 4.0") return `source licence ${JSON.stringify(m.source?.licence)} is not CC BY 4.0`;
  return null;
}

/** Readout text for a share: 1 is painted for any share under 1.5%, so it says so. */
export function shareText(share) {
  return share === 1 ? "floating kelp: under 1.5% of the ~150 m cell" : `floating kelp: about ${share}% of the ~150 m cell`;
}

const km2 = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function createKelpLayer({
  id = "kelp",
  name = "Floating kelp forests",
  icon = "🌿",
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
        _lastError = `kelp.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateKelpManifest(m);
      if (bad) {
        _lastError = `Malformed kelp.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      _listed = new Set(Object.entries(m.tiles).flatMap(([z, list]) => list.map(([x, y]) => `${z}/${x}/${y}`)));
      return true;
    } catch (e) {
      _lastError = `kelp.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "Arafeh-Dalmau et al. 2025, Global floating kelp forests (Zenodo 14816612) · CC BY 4.0",
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
        label: `${lo}–${hi}% kelp`,
        color: `rgb(${p[Math.round((lo + hi) / 2)].join(",")})`,
        count: null,
      }));
      legend.push({
        label:
          "Share of each ~150 m cell where floating kelp canopy was ever detected: Landsat from 1984 for California, Oregon, parts of Washington and Alaska, Mexico, Peru, Argentina, the Falklands and Tasmania; a Sentinel-2 mosaic of 2015–2019 elsewhere, so Canada, Chile and New Zealand are underestimated; " +
          `floating-canopy kelps only (giant kelp, bull kelp, sea bamboo), not all kelp · ${km2(_manifest.kelpKm2)} km² mapped; the authors' total is ${km2(PAPER_KM2)} km² · Arafeh-Dalmau et al. 2025, CC BY 4.0`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The kelp share of the ~150 m cell at a point, from the finest tile; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "kelp.json not loaded yet" });
      const t = geoTilePixel(lat, lon, _manifest.maxLevel);
      if (!t) return row("outside");
      // an unlisted tile was never written because no kelp is mapped in it
      if (!_listed.has(`${_manifest.maxLevel}/${t.x}/${t.y}`)) return row("class", { text: NONE_TEXT, date: EDITION });
      const url = tileUrl().replace("{z}", String(_manifest.maxLevel)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      let pixel;
      try {
        pixel = await readTilePixel(url, t.px, t.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeShare(pixel.rgba, _manifest);
      if (v.kind === "none") return row("class", { text: NONE_TEXT, date: EDITION });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("class", { text: shareText(v.share), date: EDITION });
    },
    getStats() {
      return { count: _manifest ? 1 : 0, lastUpdate: _lastUpdate, error: _lastError, time: _manifest ? EDITION : null };
    },
  };
}

export const kelpLayer = createKelpLayer();
