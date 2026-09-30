import * as Cesium from 'cesium';
import { setStackedImagery } from './rasterDrape.js';
import { createTilePixelReader, gibsTileRequest } from './gibsReadout.js';
import { TILE_FAILURE_LIMIT } from './species.js';

/**
 * Modeled range (spec: docs/superpowers/specs/2026-09-30-modeled-range-design.md): iNaturalist's thresholded geomodel range for the
 * chosen species, offered only when its collection passed the monthly geomodel check (pipeline/geomodel_check.py) and its tiles
 * matched the range that was tested (pipeline/geomodel_species.py). The browser fetches the tiles directly, capped at z3.
 */
export const MODELED_LIST_URL = 'data/geomodel_species.json';
/** Under the species records (SPECIES_ZRANK 1000); observations drawn as entities are above all imagery (grill A18). */
export const MODELED_ZRANK = 990;
export const MODELED_ALPHA = 0.45;
export const MODELED_MAX_LEVEL = 3;
export const MODELED_TILE_SIZE_PX = 512;
export const INAT_TILE_SERVER = 'api.inaturalist.org:443';
export const INAT_MAX_IN_FLIGHT = 2;
export const THROTTLED_MESSAGE = 'iNaturalist is limiting map requests — try again in a minute';
export const MODELED_CREDIT = 'Modeled range: iNaturalist Geomodel, CC BY 4.0';

export function modeledTileTemplate(taxonId) {
  return `https://api.inaturalist.org/v2/geomodel/${taxonId}/{z}/{x}/{y}.png?thresholded=true`;
}

/** "September 2026": the UTC month the verdicts were written. */
export function validationMonth(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`modeled range: bad verdicts date ${iso}`);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The collections whose include keys are in the lineage and whose exclude keys are not. */
function collectionsOf(lineage, groups) {
  const has = new Set(lineage);
  return Object.entries(groups)
    .filter(([, g]) => g.include.some((k) => has.has(k)) && !g.exclude.some((k) => has.has(k)))
    .map(([name]) => name);
}

/**
 * Where a GBIF taxon (`client.speciesName`: scientificName, rank, lineage) stands against the species list: one of the spec's states.
 * The list names only species of passing collections; anything else is placed in its collection from its GBIF lineage.
 */
export function placeTaxon(taxon, list) {
  if (!list) return { state: 'no-list' };
  const month = validationMonth(list.verdicts_generated_at);
  if (taxon.rank !== 'SPECIES') return { state: 'not-species', month };
  const entry = list.species[taxon.scientificName];
  if (entry) {
    const { id, group, iou } = entry;
    if (iou === null) return { state: 'unchecked', group, month };
    if (iou < list.species_iou_min) return { state: 'tiles-disagree', group, iou, month };
    return { state: 'shown', id, group, iou, month };
  }
  const found = collectionsOf(taxon.lineage, list.groups);
  if (found.length > 1) console.error('[modeled-range] taxon in more than one collection', { taxon, found });
  const group = found[0] ?? null;
  const verdict = group ? list.groups[group].verdict : null;
  if (verdict === 'fail') return { state: 'group-failed', group, month };
  if (verdict === 'insufficient') return { state: 'group-insufficient', group, month };
  return { state: 'not-in-model', group, month };
}

/** The card's line for a placement: why there is no switch, or what the switch shows. */
export function modeledNote(place) {
  const { state, group, month } = place;
  switch (state) {
    case 'loading': return 'Checking for a modeled range…';
    case 'shown': return `iNaturalist Geomodel · ${group} passed validation ${month}`;
    case 'group-failed': return `No modeled range: ${group} failed validation (${month})`;
    case 'group-insufficient': return `No modeled range: too few ${group} species could be tested (${month})`;
    case 'tiles-disagree': return `No modeled range: iNaturalist's map tiles differ from the range that was tested (overlap ${place.iou})`;
    case 'unchecked': return "No modeled range: its map tiles couldn't be checked this month";
    case 'not-in-model': return "No modeled range: not in iNaturalist's geomodel under this name";
    case 'not-species': return 'No modeled range: only species have one';
    case 'lookup-failed': return `No modeled range: GBIF lookup failed (${place.error})`;
    case 'no-list': return `Modeled ranges unavailable: the validation list failed to load (${place.error ?? 'no file'})`;
    default: throw new Error(`unknown modeled-range state ${state}`);
  }
}

/** A loader that fetches the list once per page; a failure is forgotten so a later pick retries. */
export function loadModeledList({ fetchImpl = (u) => fetch(u), url = MODELED_LIST_URL } = {}) {
  let pending = null;
  return () => {
    if (!pending) {
      pending = (async () => {
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })();
      pending.catch(() => { pending = null; });
    }
    return pending;
  };
}

export function createModeledRangeLayer({
  providerFor = (url, options) => new Cesium.UrlTemplateImageryProvider({ url, ...options }),
  imageryLayerFor = (provider, options) => new Cesium.ImageryLayer(provider, options),
  stack = setStackedImagery,
  scheduler = Cesium.RequestScheduler,
  readTilePixel = createTilePixelReader(),
} = {}) {
  let _viewer = null;
  let _imagery = null;
  let _taxon = null; // { id, name, group, month } while a shown species is chosen
  let _enabled = false;
  let _generation = 0;
  let _failures = 0;
  let _error = null;
  const _listeners = new Set();
  const notify = () => { for (const fn of _listeners) fn(); };

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, 'modeled-range', null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
  };

  // Off means no layer at all, so a switched-off field requests no tiles.
  const rebuild = () => {
    drop();
    _generation += 1;
    if (!_viewer || !_taxon || !_enabled) return;
    const generation = _generation;
    const provider = providerFor(modeledTileTemplate(_taxon.id), {
      maximumLevel: MODELED_MAX_LEVEL, tileWidth: MODELED_TILE_SIZE_PX, tileHeight: MODELED_TILE_SIZE_PX, credit: MODELED_CREDIT,
    });
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      const error = tileError?.error ?? tileError;
      if (!(error instanceof Cesium.RequestErrorEvent)) return;
      _failures += 1;
      // Q4 flip check: throttling is surfaced the first time, never as a quietly blank field.
      const next = error.statusCode === 429 ? THROTTLED_MESSAGE : _failures >= TILE_FAILURE_LIMIT ? 'map tiles failing' : null;
      if (next && next !== _error) {
        _error = next;
        console.error('[Data:modeled-range] iNaturalist tiles failing', { taxon: _taxon, statusCode: error.statusCode, error });
        notify();
      }
    });
    _imagery = imageryLayerFor(provider, { alpha: MODELED_ALPHA });
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, 'modeled-range', _imagery, MODELED_ZRANK);
  };

  return {
    id: 'modeled-range',
    icon: '🗺',
    get name() { return `Modeled range of ${_taxon?.name ?? 'the chosen species'} (iNaturalist Geomodel)`; },

    init(viewer) {
      _viewer = viewer;
      scheduler.requestsByServer[INAT_TILE_SERVER] = INAT_MAX_IN_FLIGHT;
      rebuild();
    },
    /** A shown species ({id, name, group, month}) or null. Every new species starts switched off. */
    setTaxon(taxon) {
      _taxon = taxon;
      _enabled = false;
      _failures = 0;
      _error = null;
      rebuild();
      notify();
    },
    setEnabled(on) {
      _enabled = Boolean(on && _taxon);
      _failures = 0;
      _error = null;
      rebuild();
      notify();
    },
    isEnabled() { return _enabled; },
    getStatus() { return { error: _error, taxon: _taxon, enabled: _enabled }; },
    onStatus(listener) {
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },
    /** A WHAT LIVES HERE row: whether the point is inside the thresholded range, from one pixel of the z3 tile. Null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled || !_taxon) return null;
      const taxon = _taxon;
      const row = (status, extra = {}) => ({ id: 'modeled-range', name: this.name, icon: this.icon, status, text: null, date: null, ...extra });
      const req = gibsTileRequest(modeledTileTemplate(taxon.id), MODELED_MAX_LEVEL, lat, lon, MODELED_TILE_SIZE_PX);
      if (!req) return row('outside');
      let pixel;
      try {
        pixel = await readTilePixel(req.url, req.px, req.py);
      } catch (e) {
        console.error('[Data:modeled-range] readout failed', { lat, lon, url: req.url, error: e });
        return row('error', { error: e?.message || String(e) });
      }
      const inside = pixel.rgba[3] > 0;
      return row('class', {
        text: inside ? 'Inside modeled range — expected nearby' : 'Outside modeled range',
        date: `${taxon.group} passed validation ${taxon.month}`,
      });
    },
  };
}
