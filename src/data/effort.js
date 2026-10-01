import * as Cesium from 'cesium';
import { setStackedImagery } from './rasterDrape.js';
import { TILE_FAILURE_LIMIT } from './species.js';
import { effortTileTemplate, yearLabel, yearRange, SPECIES_TILE_SIZE_PX } from '../bio/gbif.js';
import { GROUP_PLAIN_NAMES } from './modeledRange.js';

/**
 * Recording effort (spec: docs/superpowers/specs/2026-09-30-effort-layer-design.md): where anyone recorded the chosen species' class on
 * GBIF, so an empty patch on the species map reads as "nobody looked" (no hexagons) or "looked and not found" (hexagons, no records).
 */
/** Under the modeled range (990) and the species records (1000). */
export const EFFORT_ZRANK = 980;
export const EFFORT_ALPHA = 0.6;
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
    case 'shown': return `Where anyone recorded ${effortClassName(place.className)} · GBIF CC0/CC BY, ${yearLabel(place.years, place.now)} · purple few, white many`;
    case 'no-class': return 'No effort map: GBIF lists no class for this species';
    case 'lookup-failed': return `No effort map: GBIF lookup failed (${place.error})`;
    default: throw new Error(`unknown effort state ${place.state}`);
  }
}

export function createEffortLayer({
  providerFor = (url, options) => new Cesium.UrlTemplateImageryProvider({ url, ...options }),
  imageryLayerFor = (provider, options) => new Cesium.ImageryLayer(provider, options),
  stack = setStackedImagery,
  now = () => new Date(),
} = {}) {
  let _viewer = null;
  let _imagery = null;
  let _taxon = null; // { classKey, className } while a species with a class is chosen
  let _years = 'recent';
  let _enabled = false;
  let _generation = 0;
  let _failures = 0;
  let _error = null;
  const _listeners = new Set();
  const notify = () => { for (const fn of _listeners) fn(); };

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, 'effort', null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
  };

  // Off means no layer at all, so a switched-off map asks GBIF for nothing. Every redraw starts its failure count afresh.
  const rebuild = () => {
    drop();
    _generation += 1;
    _failures = 0;
    _error = null;
    if (!_viewer || !_taxon || !_enabled) return;
    const generation = _generation;
    const provider = providerFor(effortTileTemplate({ classKey: _taxon.classKey, years: _years, now: now() }), {
      tileWidth: SPECIES_TILE_SIZE_PX, tileHeight: SPECIES_TILE_SIZE_PX, credit: EFFORT_CREDIT,
    });
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      const error = tileError?.error ?? tileError;
      if (!(error instanceof Cesium.RequestErrorEvent)) return;
      _failures += 1;
      if (_failures >= TILE_FAILURE_LIMIT && _error === null) {
        _error = 'map tiles failing';
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
