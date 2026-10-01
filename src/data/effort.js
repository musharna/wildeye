import * as Cesium from 'cesium';
import { setStackedImagery } from './rasterDrape.js';
import { effortTileTemplate, yearLabel, yearRange, SPECIES_TILE_SIZE_PX } from '../bio/gbif.js';
import { GROUP_PLAIN_NAMES } from './modeledRange.js';

/**
 * Recording effort (spec: docs/superpowers/specs/2026-09-30-effort-layer-design.md): a grey veil over the globe, darkest where nobody
 * recorded the chosen species' class on GBIF and clearer the more they did (the maintainer's pick D, as eBird Status and Trends greys
 * out "no data"). The species' own records stay the only colour on the map. An empty patch on the species map then reads as "nobody
 * looked" (dark) or "looked and not found" (clear, no records).
 */
/** Under the modeled range (990) and the species records (1000). */
export const EFFORT_ZRANK = 980;
/** The veil carries its own transparency per pixel, so the layer is drawn whole. */
export const EFFORT_ALPHA = 1;
/** One neutral grey; its opacity is the darkness. */
export const VEIL_RGB = [24, 24, 24];
/** Opacity where no record of the class was found. */
export const VEIL_NONE = 0.72;
/** Opacity at or below EFFORT_SPARSE_PER_KM2: a little recording, still clearly lighter than none. */
export const VEIL_SPARSE = 0.58;
/**
 * Records per km² at which the shade starts to clear (one record per 10,000 km²) and is gone (one per km²), log-linear between. Arachnids
 * 2017-2026 run from 0 on the Canadian tundra to about 0.4 per km² in the Appalachians (z3 x2 y3, 2026-10-01).
 */
export const EFFORT_SPARSE_PER_KM2 = 1e-4;
export const EFFORT_CLEAR_PER_KM2 = 1;
/** Cells across a tile: 32 px of a 512 px tile. */
export const EFFORT_CELLS = 16;
/** The finest level asked of GBIF; Cesium enlarges it beyond. 16 cells on a level-7 tile are about 20 km at the equator. */
export const EFFORT_MAX_LEVEL = 7;
const EARTH_CIRCUMFERENCE_KM = 40075.016686;

/**
 * Records in each cell of an EFFORT_CELLS × EFFORT_CELLS grid over one GBIF vector tile (row-major, top row first), each feature counted in
 * the cell holding the middle of its bounds. GBIF answers an empty tile with 204 and no body: every cell 0. The decoders load with the
 * first tile, so the app's start does not carry them.
 */
export async function cellRecords(buffer) {
  const cells = new Float64Array(EFFORT_CELLS * EFFORT_CELLS);
  if (!buffer || buffer.byteLength === 0) return cells;
  const [{ PbfReader }, { VectorTile }] = await Promise.all([import('pbf'), import('@mapbox/vector-tile')]);
  const layer = new VectorTile(new PbfReader(new Uint8Array(buffer))).layers.occurrence;
  if (!layer) return cells;
  for (let i = 0; i < layer.length; i += 1) {
    const feature = layer.feature(i);
    const total = feature.properties.total;
    if (!Number.isFinite(total) || total < 0) throw new Error(`effort tile: feature ${i} has no record count (total ${total})`);
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ring of feature.loadGeometry()) {
      for (const { x, y } of ring) {
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2];
    // the tile's buffer repeats its neighbours' edges: those records are counted in the neighbour
    if (!(cx >= 0 && cx < layer.extent && cy >= 0 && cy < layer.extent)) continue;
    cells[Math.floor((cy / layer.extent) * EFFORT_CELLS) * EFFORT_CELLS + Math.floor((cx / layer.extent) * EFFORT_CELLS)] += total;
  }
  return cells;
}

/** Ground area (km²) of a cell in `row` of Web Mercator tile row `tileY` at `level`: its side at the equator times cos² of its latitude. */
export function cellAreaKm2({ level, tileY, row }) {
  if (!Number.isInteger(level) || level < 0) throw new Error(`cellAreaKm2: bad level ${level}`);
  if (!Number.isInteger(tileY) || tileY < 0 || tileY >= 2 ** level) throw new Error(`cellAreaKm2: bad tileY ${tileY} at level ${level}`);
  const side = EARTH_CIRCUMFERENCE_KM / 2 ** level / EFFORT_CELLS;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + (row + 0.5) / EFFORT_CELLS)) / 2 ** level)));
  return (side * Math.cos(lat)) ** 2;
}

/** Veil opacity of a cell from its records per km²: VEIL_NONE with none, VEIL_SPARSE up to EFFORT_SPARSE_PER_KM2, clear from EFFORT_CLEAR_PER_KM2. */
export function veilAlpha(records, areaKm2) {
  if (!Number.isFinite(records) || records < 0) throw new Error(`veilAlpha: bad records ${records}`);
  if (!Number.isFinite(areaKm2) || areaKm2 <= 0) throw new Error(`veilAlpha: bad area ${areaKm2}`);
  if (records === 0) return VEIL_NONE;
  const lo = Math.log10(EFFORT_SPARSE_PER_KM2);
  const t = Math.min(1, Math.max(0, (Math.log10(records / areaKm2) - lo) / (Math.log10(EFFORT_CLEAR_PER_KM2) - lo)));
  return VEIL_SPARSE * (1 - t);
}

export const EFFORT_CREDIT = 'Recording effort: GBIF.org, CC0 / CC BY records';

/** A geomodel collection's class in plain words; any other class by its GBIF name. */
export function effortClassName(className) {
  if (typeof className !== 'string' || !className) throw new Error(`effort: bad class name ${className}`);
  return GROUP_PLAIN_NAMES[className] ?? `class ${className}`;
}

/** The card's line: what the switch draws, or why there is none. */
export function effortNote(place) {
  switch (place.state) {
    case 'loading': return 'Checking for an effort map…';
    case 'shown': return `Darker = fewer records of ${effortClassName(place.className)}, darkest = none · GBIF CC0/CC BY, ${yearLabel(place.years, place.now)}`;
    case 'no-class': return 'No effort map: GBIF lists no class for this species';
    case 'lookup-failed': return `No effort map: GBIF lookup failed (${place.error})`;
    default: throw new Error(`unknown effort state ${place.state}`);
  }
}

/**
 * The provider with each tile drawn from GBIF's counts: the tile's vector tile (`template`, {z}/{x}/{y}) fetched with Cesium's request, so
 * its throttle applies, summed into cells and drawn as grey squares by veilAlpha. Undefined (throttled) and failures pass through
 * untouched, so the provider's error event still sees them.
 */
export function veilProvider(base, template, {
  fetchTile = (url, request) => new Cesium.Resource({ url, request }).fetchArrayBuffer(),
  createCanvas = () => document.createElement('canvas'),
} = {}) {
  if (!['{z}', '{x}', '{y}'].every((key) => template.includes(key))) throw new Error(`veilProvider: template ${template} lacks {z}, {x} or {y}`);
  base.requestImage = (x, y, level, request) => {
    const pending = fetchTile(template.replace('{z}', String(level)).replace('{x}', String(x)).replace('{y}', String(y)), request);
    if (!pending) return pending;
    return pending.then(async (buffer) => {
      const cells = await cellRecords(buffer);
      const canvas = createCanvas();
      canvas.width = base.tileWidth;
      canvas.height = base.tileHeight;
      const ctx = canvas.getContext('2d');
      const [w, h] = [base.tileWidth / EFFORT_CELLS, base.tileHeight / EFFORT_CELLS];
      for (let row = 0; row < EFFORT_CELLS; row += 1) {
        const area = cellAreaKm2({ level, tileY: y, row });
        for (let col = 0; col < EFFORT_CELLS; col += 1) {
          ctx.fillStyle = `rgba(${VEIL_RGB.join(', ')}, ${veilAlpha(cells[row * EFFORT_CELLS + col], area)})`;
          ctx.fillRect(col * w, row * h, w, h);
        }
      }
      return canvas;
    });
  };
  return base;
}

export function createEffortLayer({
  providerFor = (url, options) => new Cesium.UrlTemplateImageryProvider({ url, ...options }),
  imageryLayerFor = (provider, options) => new Cesium.ImageryLayer(provider, options),
  stack = setStackedImagery,
  veil = veilProvider,
  now = () => new Date(),
} = {}) {
  let _viewer = null;
  let _imagery = null;
  let _taxon = null; // { classKey, className } while a species with a class is chosen
  let _years = 'recent';
  let _enabled = false;
  let _generation = 0;
  let _error = null;
  const _listeners = new Set();
  const notify = () => { for (const fn of _listeners) fn(); };

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, 'effort', null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
  };

  // Off means no layer at all, so a switched-off map asks GBIF for nothing. Every redraw starts with no error.
  const rebuild = () => {
    drop();
    _generation += 1;
    _error = null;
    if (!_viewer || !_taxon || !_enabled) return;
    const generation = _generation;
    const template = effortTileTemplate({ classKey: _taxon.classKey, years: _years, now: now() });
    const provider = veil(providerFor(template, {
      tileWidth: SPECIES_TILE_SIZE_PX, tileHeight: SPECIES_TILE_SIZE_PX, maximumLevel: EFFORT_MAX_LEVEL, credit: EFFORT_CREDIT,
    }), template);
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      const error = tileError?.error ?? tileError;
      if (!(error instanceof Cesium.RequestErrorEvent)) return;
      // the first failure is said: a tile that never draws leaves its patch unveiled, which reads as well recorded
      if (_error === null) {
        _error = 'effort map tiles failing: clear patches may be missing data';
        console.error('[Data:effort] GBIF effort tiles failing', { taxon: _taxon, years: _years, statusCode: error.statusCode, error });
        notify();
      }
    });
    _imagery = imageryLayerFor(provider, { alpha: EFFORT_ALPHA });
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, 'effort', _imagery, EFFORT_ZRANK);
  };

  return {
    id: 'effort',
    init(viewer) {
      _viewer = viewer;
      rebuild();
    },
    /** The chosen species' class ({classKey, className}) or null. Every new species starts switched off. */
    setTaxon(taxon) {
      _taxon = taxon;
      _enabled = false;
      rebuild();
      notify();
    },
    /** The species map's years ('recent' or 'all'); redraws when on. */
    setYears(years) {
      yearRange(years); // throws on anything but 'recent' or 'all'
      if (years === _years) return;
      _years = years;
      if (_enabled) rebuild();
      notify();
    },
    setEnabled(on) {
      _enabled = Boolean(on && _taxon);
      rebuild();
      notify();
    },
    isEnabled() { return _enabled; },
    getStatus() { return { error: _error, taxon: _taxon, enabled: _enabled, years: _years }; },
    onStatus(listener) {
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },
  };
}
