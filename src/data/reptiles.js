import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";
import { geoTilePixel } from "./humanFootprint.js";
import { cellCentre } from "./mammals.js";

/**
 * Reptile species richness from GARD 1.7 (Roll & Meiri 2022, Zenodo 10.5281/zenodo.6499637, CC0): how many of 10,914
 * terrestrial reptile species' ranges overlap each 0.1° cell, rasterised by pipeline/reptiles.py into a geographic tile
 * pyramid with one palette colour per count (spec docs/superpowers/specs/2026-10-03-reptile-richness-design.md), plus
 * level-3 RGB tiles holding the lizard, snake and turtle counts. A point readout decodes both exactly from level 3.
 * Nothing varies with time.
 */
export const MANIFEST_URL = "data/reptiles.json";
export const TILE_FAILURE_LIMIT = 8;
const TILE = 256;
const SOURCE = "Reptile richness: GARD 1.7 (Roll & Meiri)";

/** null when reptiles.json has the shape pipeline/reptiles.py writes; otherwise what is wrong with it. */
export function validateManifest(m) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  const { maxLevel, tile, groupTile, palette, maxSpecies } = m;
  if (!Number.isInteger(maxLevel) || maxLevel < 0) return `maxLevel ${JSON.stringify(maxLevel)} is not a level`;
  if (typeof tile !== "string" || !["{z}", "{x}", "{y}"].every((k) => tile.includes(k)))
    return `tile ${JSON.stringify(tile)} lacks {z}, {x} or {y}`;
  if (typeof groupTile !== "string" || !["{x}", "{y}"].every((k) => groupTile.includes(k)))
    return `groupTile ${JSON.stringify(groupTile)} lacks {x} or {y}`;
  if (!Number.isInteger(maxSpecies) || maxSpecies < 1 || maxSpecies > 255) return `maxSpecies ${JSON.stringify(maxSpecies)} is not 1–255`;
  if (!Array.isArray(palette) || palette.length !== maxSpecies + 1 || !palette.every((c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)))
    return `palette is not ${maxSpecies + 1} RGB colours`;
  if (new Set(palette.slice(1).map(String)).size !== maxSpecies) return "palette colours are not distinct";
  return null;
}

const tables = new WeakMap();
/** The species count a display pixel stands for: transparent is none; an opaque palette colour is its index. */
export function decodeCount(rgba, palette) {
  if (rgba[3] === 0) return { kind: "none" };
  let t = tables.get(palette);
  if (!t) tables.set(palette, (t = new Map(palette.slice(1).map((c, k) => [`${c.join(",")},255`, k + 1]))));
  const n = t.get(rgba.join(","));
  return n === undefined ? { kind: "unknown", rgba } : { kind: "value", n };
}

const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The readout line: the total, then lizards, snakes, turtles and other (amphisbaenians, crocodilians, the tuatara). */
export function countText(total, [lizards, snakes, turtles]) {
  const other = total - lizards - snakes - turtles;
  return (
    `${plural(total, "reptile species", "reptile species")}: ${plural(lizards, "lizard", "lizards")}, ` +
    `${plural(snakes, "snake", "snakes")}, ${plural(turtles, "turtle", "turtles")}, ${other.toLocaleString("en-US")} other`
  );
}

export function createReptilesLayer({
  id = "reptiles",
  name = "Reptile richness (GARD 1.7)",
  icon = "🦎",
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
        _lastError = `reptiles.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateManifest(m);
      if (bad) {
        _lastError = `Malformed reptiles.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      return true;
    } catch (e) {
      _lastError = `reptiles.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "Roll et al. 2017 / Caetano et al. 2022, GARD 1.7 (Zenodo 10.5281/zenodo.6499637) · CC0",
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
        ? [1, 25, 50, 100, 150, _manifest.maxSpecies]
            .filter((v, i, a) => v <= _manifest.maxSpecies && a.indexOf(v) === i)
            .map((v) => ({ label: `${v}`, color: `rgb(${_manifest.palette[v].join(",")})`, count: null }))
        : [];
      legend.push({
        label: "Reptile species whose range overlaps each 0.1° cell (GARD 1.7 range maps of 10,914 species; expert ranges, not survey records)",
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The species count at a point and its split by group, from the level-3 display and group tiles; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "reptiles.json not loaded yet" });
      const z = _manifest.maxLevel;
      // the pixel under the centre of the clicked point's 0.1° cell, which holds that cell's counts
      const c = cellCentre(lat, lon);
      const t = c && geoTilePixel(c[0], c[1], z);
      if (!t) return row("outside");
      const at = (tmpl) => tmpl.replace("{z}", String(z)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      let shown, groups;
      try {
        shown = await readTilePixel(at(_manifest.tile), t.px, t.py);
        const v = decodeCount(shown.rgba, _manifest.palette);
        if (v.kind === "none") return row("class", { text: "No mapped reptile range", date: "GARD 1.7" });
        if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
        groups = await readTilePixel(at(_manifest.groupTile), t.px, t.py);
        const [l, s, tu, a] = groups.rgba;
        if (a !== 255 || l + s + tu > v.n)
          return row("error", { error: `group pixel ${groups.rgba.join(",")} does not fit ${v.n} species` });
        return row("value", { text: countText(v.n, [l, s, tu]), date: "GARD 1.7" });
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

export const reptilesLayer = createReptilesLayer();
