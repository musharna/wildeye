import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";
import { epochAt, geoTilePixel } from "./humanFootprint.js";
import { listedTilesOnly } from "./protectedAreas.js";
import { decodeTidalMarsh as decodeShare, LEGEND_BINS } from "./tidalMarsh.js";

/**
 * Global 10-meter seagrass maps, 2019–2020 and 2023–2024 (Peng, Li, Krause, Lyons, Murray, Schill, Roelfsema and Asner;
 * Zenodo 18612240, CC BY 4.0): seagrass mapped from Sentinel-2 along the world's coasts between 51°S and 72°N.
 * pipeline/seagrass.py counts, per epoch and for every pixel of a geographic tile pyramid to level 9 (~150 m), the 10 m
 * pixels whose centre falls in it and how many of them are seagrass, and paints the share in whole percent (spec
 * docs/superpowers/specs/2026-10-04-seagrass-design.md). Only painted tiles exist; a tile the manifest does not list is
 * served blank without a request. On the time bar the epoch whose first year is at or before the observed date is drawn
 * (with no date set, the latest); before the first there is none. A point readout decodes the share exactly from the
 * finest tile of the shown epoch.
 */
export const MANIFEST_URL = "data/seagrass.json";
export const TILE_FAILURE_LIMIT = 8;
export const NONE_TEXT = "no seagrass mapped in this ~150 m cell";
// the extent of the release's own GeoTIFFs (72.338°N to 51.293°S), rounded inwards
export const MAPPED_NORTH = 72.33;
export const MAPPED_SOUTH = -51.29;
const TILE = 256;
const SOURCE = "Global 10-meter seagrass maps: Peng et al.";

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);

function badTiles(tiles, maxLevel) {
  if (!tiles || typeof tiles !== "object") return "tiles is not an object";
  for (let z = 0; z <= maxLevel; z += 1) {
    const list = tiles[String(z)];
    if (!Array.isArray(list)) return `tiles has no list for level ${z}`;
    for (const t of list) {
      const ok = Array.isArray(t) && t.length === 2 && Number.isInteger(t[0]) && Number.isInteger(t[1]) && t[0] >= 0 && t[0] < 2 ** (z + 1) && t[1] >= 0 && t[1] < 2 ** z;
      if (!ok) return `tile ${JSON.stringify(t)} is not on level ${z}`;
    }
  }
  return null;
}

/** null when seagrass.json has the shape pipeline/seagrass.py writes; otherwise what is wrong with it. */
export function validateSeagrassManifest(m) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  if (typeof m.generated_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.generated_at)) return `generated_at ${JSON.stringify(m.generated_at)} is not a UTC time`;
  if (!Number.isInteger(m.maxLevel) || m.maxLevel < 0) return `maxLevel ${JSON.stringify(m.maxLevel)} is not a level`;
  if (typeof m.tile !== "string" || !["{epoch}", "{z}", "{x}", "{y}"].every((k) => m.tile.includes(k))) return `tile ${JSON.stringify(m.tile)} lacks {epoch}, {z}, {x} or {y}`;
  if (!Array.isArray(m.epochs) || !m.epochs.length) return "epochs is not a list of epochs";
  for (const [i, e] of m.epochs.entries()) {
    const at = `epoch ${JSON.stringify(e?.key)}`;
    if (typeof e?.key !== "string" || !/^\d{4}_\d{4}$/.test(e.key)) return `${at} is not a YYYY_YYYY key`;
    if (e.year !== Number(e.key.slice(0, 4))) return `${at} year ${JSON.stringify(e.year)} is not its first year`;
    if (i > 0 && !(e.year > m.epochs[i - 1].year)) return `${at} does not follow ${m.epochs[i - 1].key}`;
    if (typeof e.label !== "string" || !e.label) return `${at} has no label`;
    if (!Number.isInteger(e.members) || e.members < 1) return `${at} members ${JSON.stringify(e.members)} is not a count`;
    if (typeof e.seagrassKm2 !== "number" || !(e.seagrassKm2 > 0)) return `${at} seagrassKm2 ${JSON.stringify(e.seagrassKm2)} is not an area`;
    const bad = badTiles(e.tiles, m.maxLevel);
    if (bad) return `${at}: ${bad}`;
  }
  const p = m.palette;
  if (!Array.isArray(p) || p.length !== 101 || !p.every(isRgb)) return "palette is not 101 RGB colours";
  if (new Set(p.slice(1).map(String)).size !== 100) return "palette shares 1–100% are not distinct colours";
  if (m.source?.licence !== "CC BY 4.0") return `source licence ${JSON.stringify(m.source?.licence)} is not CC BY 4.0`;
  return null;
}

/** Readout text for a share: 1 is painted for any share under 1.5%, so it says so. */
export function shareText(share) {
  return share === 1 ? "seagrass: under 1.5% of the ~150 m cell" : `seagrass: about ${share}% of the ~150 m cell`;
}

const n = (v) => Math.round(v).toLocaleString("en-US");

export function createSeagrassLayer({
  id = "seagrass",
  name = "Seagrass (2019–2020, 2023–2024)",
  icon = "🌱",
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
    _observed = null,
    _drawn = null,
    _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  /** The epoch drawn at the observed time, or null before the first. */
  const shown = () => {
    if (!_manifest) return null;
    const year = epochAt(_observed, _manifest.epochs.map((e) => e.year));
    return year === null ? null : _manifest.epochs.find((e) => e.year === year);
  };
  // the build time busts tiles cached from an earlier build, for the drape and the readout alike
  const tileUrl = (epoch) => `${_manifest.tile.replace("{epoch}", epoch.key)}?v=${_manifest.generated_at}`;

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, id, null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
    _drawn = null;
  };

  const draw = (epoch) => {
    drop();
    _generation += 1;
    _tileFailures = 0;
    _lastError = null;
    const generation = _generation;
    const provider = listedTilesOnly(
      providerFor({
        url: tileUrl(epoch),
        tilingScheme: new Cesium.GeographicTilingScheme(),
        tileWidth: TILE,
        tileHeight: TILE,
        maximumLevel: _manifest.maxLevel,
        credit: SOURCE,
      }),
      _listed.get(epoch.key),
      blank, // undefined: listedTilesOnly's own blank canvas
    );
    // only listed tiles are requested, and every one was written: any tile error is a fault
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = "map tiles failing";
        console.error(`[Data:${id}] tiles failing`, { epoch: epoch.key, error: tileError?.error ?? tileError });
      }
    });
    _imagery = imageryLayerFor(provider);
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
    _drawn = epoch.key;
  };

  const apply = () => {
    const epoch = shown();
    if (epoch === null) {
      if (_imagery) _imagery.show = false;
      _lastError = `no seagrass mapped before ${_manifest.epochs[0].year} (shown: ${String(_observed).slice(0, 10)})`;
      return;
    }
    if (_lastError?.startsWith("no seagrass mapped before")) _lastError = null;
    // Cesium never re-requests a failed tile; a fresh provider is the retry
    if (!_imagery || _drawn !== epoch.key || _lastError === "map tiles failing") draw(epoch);
    else _imagery.show = _enabled;
  };

  const load = async () => {
    try {
      const res = await fetchImpl(MANIFEST_URL);
      if (!res.ok) {
        _lastError = `seagrass.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateSeagrassManifest(m);
      if (bad) {
        _lastError = `Malformed seagrass.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      _listed = new Map(m.epochs.map((e) => [e.key, new Set(Object.entries(e.tiles).flatMap(([z, list]) => list.map(([x, y]) => `${z}/${x}/${y}`)))]));
      return true;
    } catch (e) {
      _lastError = `seagrass.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "Peng et al., Global 10-meter seagrass maps 2019–2020 and 2023–2024 (Zenodo 18612240) · CC BY 4.0",
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
    /** Shared observed-time hook: Jan 1 of the first epoch's first year to Dec 31 of the last epoch's last year; null until seagrass.json is read. */
    getObservedExtent() {
      if (!_manifest) return null;
      const e = _manifest.epochs;
      return { startMs: Date.UTC(e[0].year, 0, 1), endMs: Date.UTC(Number(e[e.length - 1].key.slice(5)), 11, 31, 23, 59, 59, 999) };
    },
    destroy() {
      drop();
      _viewer = null;
      _enabled = false;
      _observed = null;
    },
    getRowControls() {
      if (!_manifest) return { chips: [], legend: [] };
      const p = _manifest.palette;
      const legend = LEGEND_BINS.map(([lo, hi]) => ({
        label: `${lo}–${hi}% seagrass`,
        color: `rgb(${p[Math.round((lo + hi) / 2)].join(",")})`,
        count: null,
      }));
      const epoch = shown();
      const area = epoch ? ` · ${n(epoch.seagrassKm2)} km² mapped in ${epoch.label}` : "";
      legend.push({
        label: `Share of each ~150 m cell mapped as seagrass, from a 10 m Sentinel-2 map of the coasts between 51°S and 72°N${area}. The two epochs' maps often disagree cell by cell: a difference between them is not on its own a change in the meadow · Peng et al., CC BY 4.0`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The seagrass share of the ~150 m cell at a point, from the finest tile of the shown epoch; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "seagrass.json not loaded yet" });
      const epoch = shown();
      if (epoch === null) return row("gap", { observed: _observed });
      if (lat > MAPPED_NORTH || lat < MAPPED_SOUTH) return row("outside");
      const t = geoTilePixel(lat, lon, _manifest.maxLevel);
      if (!t) return row("outside");
      const date = epoch.label;
      // an unlisted tile was never written because no seagrass is mapped in it
      if (!_listed.get(epoch.key).has(`${_manifest.maxLevel}/${t.x}/${t.y}`)) return row("class", { text: NONE_TEXT, date });
      const url = tileUrl(epoch).replace("{z}", String(_manifest.maxLevel)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      let pixel;
      try {
        pixel = await readTilePixel(url, t.px, t.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeShare(pixel.rgba, _manifest);
      if (v.kind === "none") return row("class", { text: NONE_TEXT, date });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      return row("class", { text: shareText(v.share), date });
    },
    getStats() {
      const epoch = shown();
      return {
        count: _manifest ? 1 : 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        time: epoch ? epoch.label : null,
        observed: _observed,
      };
    },
  };
}

export const seagrassLayer = createSeagrassLayer();
