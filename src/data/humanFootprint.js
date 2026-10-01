import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";

/**
 * Human footprint, five snapshots 2000–2024 (Mu et al. 2022, Scientific Data 9:176, doi:10.1038/s41597-022-01284-8;
 * figshare 16571064 v8, CC BY 4.0): human pressure on land, 0 (wild) to 50, area-averaged from 1 km to ~5 km and cut
 * by pipeline/hfp.py into a geographic tile pyramid with one palette colour per bin (spec
 * docs/superpowers/specs/2026-10-01-human-footprint-design.md). On the time bar the snapshot at or before the observed
 * date is drawn; before the first there is none. A point readout decodes the bin exactly from the finest tile.
 */
export const MANIFEST_URL = "data/hfp.json";
export const TILE_FAILURE_LIMIT = 8;
const TILE = 256;
const SOURCE = "Human Footprint: Mu et al. 2022";

/** Geographic-scheme tile (level z: 2^(z+1) × 2^z tiles, y from the north) and pixel under a point; null off the globe. */
export function geoTilePixel(lat, lon, z) {
  if (!(Math.abs(lat) <= 90) || !Number.isFinite(lon)) return null;
  const nx = 2 ** (z + 1),
    ny = 2 ** z;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  // 180° wraps to −180°, so x never passes the east edge; the south pole belongs to the last row, as in Cesium's
  // GeographicTilingScheme
  const gx = Math.floor(((wrapped + 180) / 360) * nx * TILE);
  const gy = Math.min(Math.floor(((90 - lat) / 180) * ny * TILE), ny * TILE - 1);
  const x = Math.floor(gx / TILE),
    y = Math.floor(gy / TILE);
  return { x, y, px: gx - x * TILE, py: gy - y * TILE };
}

/** The snapshot year shown at an observed instant: live = the latest; otherwise the latest at or before it; null before the first. */
export function epochAt(iso, years) {
  if (!iso) return years[years.length - 1];
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new RangeError(`observed time is not a date: ${iso}`);
  const y = new Date(t).getUTCFullYear();
  let shown = null;
  for (const year of years) if (year <= y) shown = year;
  return shown;
}

/** null when hfp.json has the shape pipeline/hfp.py writes; otherwise what is wrong with it. */
export function validateManifest(m) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  const { years, maxLevel, tile, palette } = m;
  if (!Array.isArray(years) || !years.length || !years.every((y, i) => Number.isInteger(y) && (i === 0 || y > years[i - 1])))
    return `years ${JSON.stringify(years)} is not a rising list of years`;
  if (!Number.isInteger(maxLevel) || maxLevel < 0) return `maxLevel ${JSON.stringify(maxLevel)} is not a level`;
  if (typeof tile !== "string" || !["{year}", "{z}", "{x}", "{y}"].every((k) => tile.includes(k)))
    return `tile ${JSON.stringify(tile)} lacks {year}, {z}, {x} or {y}`;
  if (!Array.isArray(palette) || palette.length !== 50 || !palette.every((c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)))
    return "palette is not 50 RGB colours";
  if (new Set(palette.map(String)).size !== 50) return "palette colours are not distinct";
  return null;
}

const tables = new WeakMap();
/** One RGBA tile pixel → no data (transparent), a bin 0–49, or an unrecognised colour (named, never snapped). */
export function decodeFootprint(rgba, palette) {
  if (rgba[3] === 0) return { kind: "none" };
  let t = tables.get(palette);
  if (!t) tables.set(palette, (t = new Map(palette.map((c, k) => [`${c.join(",")},255`, k]))));
  const bin = t.get(rgba.join(","));
  return bin === undefined ? { kind: "unknown", rgba } : { kind: "value", bin };
}

export function createHumanFootprintLayer({
  id = "human-footprint",
  name = "Human footprint (Mu et al., 2000–2024)",
  icon = "👣",
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
      _lastError = `no human footprint mapped before ${_manifest.years[0]} (shown: ${String(_observed).slice(0, 10)})`;
      return;
    }
    if (_lastError?.startsWith("no human footprint")) _lastError = null;
    if (!_imagery || _drawnYear !== year || _lastError === "map tiles failing") draw(year);
    else _imagery.show = _enabled;
  };

  const load = async () => {
    try {
      const res = await fetchImpl(MANIFEST_URL);
      if (!res.ok) {
        _lastError = `hfp.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateManifest(m);
      if (bad) {
        _lastError = `Malformed hfp.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      return true;
    } catch (e) {
      _lastError = `hfp.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "Mu et al. 2022, Human Footprint 2000–2024 (figshare v8) · CC BY 4.0",
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
    /** Shared observed-time hook: the first snapshot's Jan 1 to the last one's Dec 31; null until hfp.json is read. */
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
        ? [0, 10, 20, 30, 40, 50].map((v) => ({ label: String(v), color: `rgb(${_manifest.palette[Math.min(v, 49)].join(",")})`, count: null }))
        : [];
      legend.push({ label: "Human footprint, 0 wild to 50 most altered (Mu et al. 2022), ~5 km", color: "transparent", count: null });
      return { chips: [], legend };
    },
    /** The footprint bin at a point, from the finest tile of the shown snapshot; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "hfp.json not loaded yet" });
      const year = shown();
      if (year === null) return row("gap", { observed: _observed });
      const t = geoTilePixel(lat, lon, _manifest.maxLevel);
      if (!t) return row("outside");
      const url = tileUrl(year).replace("{z}", String(_manifest.maxLevel)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      let pixel;
      try {
        pixel = await readTilePixel(url, t.px, t.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeFootprint(pixel.rgba, _manifest.palette);
      if (v.kind === "none") return row("nodata", { date: String(year) });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("value", { text: `Human footprint ${v.bin}–${v.bin + 1} of 50`, date: String(year) });
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

export const humanFootprintLayer = createHumanFootprintLayer();
