import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader } from "./gibsReadout.js";
import { geoTilePixel } from "./humanFootprint.js";
import { decodeCount } from "./reptiles.js";

/**
 * Mammal species richness from the MDD v1.2 range maps (Marsh et al. 2022, Zenodo 10.5281/zenodo.6644198, CC BY 4.0):
 * how many of the 6,360 mapped wild extant mammal species' ranges overlap each 0.1° cell, rasterised by pipeline/mammals.py
 * into a geographic tile pyramid with one palette colour per count (spec
 * docs/superpowers/specs/2026-10-04-mammal-richness-design.md), plus level-3 RGB tiles holding the rodent, bat and
 * primate counts. A point readout decodes both exactly from level 3. Nothing varies with time. Not the SEDAC layer
 * (gibs-mammals): that is NASA's rendering of IUCN 2013 ranges, colours only.
 */
export const MANIFEST_URL = "data/mammals.json";
export const TILE_FAILURE_LIMIT = 8;
export const NONE_TEXT = "No mapped mammal range";
export const DATE = "MDD v1.2 maps";
const TILE = 256;
const CELL = 0.1; // degrees: the pipeline's grid (pipeline/mammals.py RES), 3600 × 1800 cells
const SOURCE = "Mammal richness: MDD v1.2 range maps (Marsh et al.)";

/** null when mammals.json has the shape pipeline/mammals.py writes; otherwise what is wrong with it. */
export function validateManifest(m) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  const { maxLevel, tile, groupTile, palette, maxSpecies, groups, species } = m;
  if (typeof m.generated_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.generated_at)) return `generated_at ${JSON.stringify(m.generated_at)} is not a UTC time`;
  if (!Number.isInteger(maxLevel) || maxLevel < 0) return `maxLevel ${JSON.stringify(maxLevel)} is not a level`;
  if (typeof tile !== "string" || !["{z}", "{x}", "{y}"].every((k) => tile.includes(k)))
    return `tile ${JSON.stringify(tile)} lacks {z}, {x} or {y}`;
  if (typeof groupTile !== "string" || !["{x}", "{y}"].every((k) => groupTile.includes(k)))
    return `groupTile ${JSON.stringify(groupTile)} lacks {x} or {y}`;
  if (JSON.stringify(groups) !== JSON.stringify(["rodents", "bats", "primates", "other"])) return `groups ${JSON.stringify(groups)} are not rodents, bats, primates, other`;
  if (!Number.isInteger(species) || species < 1) return `species ${JSON.stringify(species)} is not a count`;
  if (!Number.isInteger(maxSpecies) || maxSpecies < 1 || maxSpecies > 255) return `maxSpecies ${JSON.stringify(maxSpecies)} is not 1–255`;
  if (!Array.isArray(palette) || palette.length !== maxSpecies + 1 || !palette.every((c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)))
    return `palette is not ${maxSpecies + 1} RGB colours`;
  if (new Set(palette.slice(1).map(String)).size !== maxSpecies) return "palette colours are not distinct";
  return null;
}

const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The readout line: the total, then rodents, bats, primates and other (every other order). */
export function countText(total, [rodents, bats, primates]) {
  const other = total - rodents - bats - primates;
  return (
    `${plural(total, "mammal species", "mammal species")}: ${plural(rodents, "rodent", "rodents")}, ` +
    `${plural(bats, "bat", "bats")}, ${plural(primates, "primate", "primates")}, ${other.toLocaleString("en-US")} other`
  );
}

export function createMammalsLayer({
  id = "mammals",
  name = "Mammal richness (MDD range maps)",
  icon = "🐭",
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
        _lastError = `mammals.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateManifest(m);
      if (bad) {
        _lastError = `Malformed mammals.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      return true;
    } catch (e) {
      _lastError = `mammals.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "Marsh et al. 2022, range maps for MDD v1.2 (Zenodo 10.5281/zenodo.6644198) · CC BY 4.0",
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
        ? [1, 50, 100, 150, 200, _manifest.maxSpecies]
            .filter((v, i, a) => v <= _manifest.maxSpecies && a.indexOf(v) === i)
            .map((v) => ({ label: `${v}`, color: `rgb(${_manifest.palette[v].join(",")})`, count: null }))
        : [];
      legend.push({
        label: `Mammal species whose range overlaps each 0.1° cell (range maps of ${(_manifest?.species ?? 6360).toLocaleString("en-US")} wild species, MDD v1.2 taxonomy; expert ranges, not survey records) · Marsh et al. 2022, CC BY 4.0`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The species count at a point and its split by group, from the level-3 display and group tiles; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "mammals.json not loaded yet" });
      const z = _manifest.maxLevel;
      // the pixel under the centre of the clicked point's cell, which holds that cell's count
      const c = cellCentre(lat, lon);
      const t = c && geoTilePixel(c[0], c[1], z);
      if (!t) return row("outside");
      const at = (tmpl) => bust(tmpl.replace("{z}", String(z)).replace("{x}", String(t.x)).replace("{y}", String(t.y)));
      try {
        const shown = await readTilePixel(at(_manifest.tile), t.px, t.py);
        const v = decodeCount(shown.rgba, _manifest.palette);
        if (v.kind === "none") return row("class", { text: NONE_TEXT, date: DATE });
        if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
        const groups = await readTilePixel(at(_manifest.groupTile), t.px, t.py);
        const [r, b, p, a] = groups.rgba;
        if (a !== 255 || r + b + p > v.n)
          return row("error", { error: `group pixel ${groups.rgba.join(",")} does not fit ${v.n} species` });
        return row("value", { text: countText(v.n, [r, b, p]), date: DATE });
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

export const mammalsLayer = createMammalsLayer();

/**
 * The centre of the 0.1° cell holding a point, or null off the globe. Level 3 (4096 × 2048 px) carries the 3600 × 1800
 * cells by nearest neighbour, so the pixel under a point off a cell's centre can hold the next cell's count; the pixel
 * under a cell's centre always holds that cell's (a pixel is 0.88 of a cell wide).
 */
export function cellCentre(lat, lon) {
  if (!(Math.abs(lat) <= 90) || !Number.isFinite(lon)) return null;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const col = Math.min(Math.floor((wrapped + 180) / CELL), Math.round(360 / CELL) - 1);
  const row = Math.min(Math.floor((90 - lat) / CELL), Math.round(180 / CELL) - 1);
  return [90 - (row + 0.5) * CELL, -180 + (col + 0.5) * CELL];
}
