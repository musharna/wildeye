// src/data/modeledRange.test.mjs — placing a GBIF taxon against the geomodel species list, and the iNaturalist tile layer.
// Spec: docs/superpowers/specs/2026-09-30-modeled-range-design.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  placeTaxon, modeledNote, validationMonth, modeledTileTemplate, loadModeledList, createModeledRangeLayer,
  MODELED_ZRANK, MODELED_ALPHA, MODELED_MAX_LEVEL, INAT_TILE_SERVER, INAT_MAX_IN_FLIGHT, THROTTLED_MESSAGE, MODELED_CREDIT,
} from './modeledRange.js';
import { SPECIES_ZRANK, TILE_FAILURE_LIMIT } from './species.js';

const LIST = {
  verdicts_generated_at: '2026-09-30T17:32:10+00:00',
  species_iou_min: 0.7,
  // OtherAnimalia first: a bird must be placed by the exclusion, not by coming later in the list
  groups: {
    OtherAnimalia: { verdict: 'fail', include: [1], exclude: [212, 216, 367] },
    Arachnida: { verdict: 'pass', include: [367], exclude: [] },
    Aves: { verdict: 'fail', include: [212], exclude: [] },
    Fungi: { verdict: 'insufficient', include: [5], exclude: [] },
  },
  species: {
    'Trachelas pacificus': { id: 298342, group: 'Arachnida', iou: 0.9316 },
    'Edgeus exactus': { id: 11, group: 'Arachnida', iou: 0.7 },
    'Edgeus below': { id: 12, group: 'Arachnida', iou: 0.6999 },
    'Stemonitis fusca': { id: 13, group: 'Arachnida', iou: 0.14 },
    'Uncheckus nullus': { id: 14, group: 'Arachnida', iou: null },
    'Skimmus unus': { id: 15, group: 'Arachnida', iou: 0.88, check: 'skim', iou_skim: 0.88 },
  },
};
const SPIDER = { key: 2148457, scientificName: 'Trachelas pacificus', rank: 'SPECIES', lineage: [1, 54, 367, 1496, 8342328, 2148457] };
const record = (scientificName, lineage, rank = 'SPECIES') => ({ key: 9, scientificName, rank, lineage });

test('placeTaxon: a species of a passing collection whose tiles agree is shown, with its collection and validation month', () => {
  // an entry without a check kind predates skims: only full checks were written then
  assert.deepEqual(placeTaxon(SPIDER, LIST), { state: 'shown', id: 298342, group: 'Arachnida', iou: 0.9316, check: 'full', month: 'September 2026' });
});

test('placeTaxon: a species checked on one tile (skim) is shown too, and says which check it passed', () => {
  assert.deepEqual(placeTaxon(record('Skimmus unus', [1, 54, 367, 15]), LIST), { state: 'shown', id: 15, group: 'Arachnida', iou: 0.88, check: 'skim', month: 'September 2026' });
});

test('placeTaxon: the IoU floor is inclusive at species_iou_min and hides anything below it', () => {
  assert.equal(placeTaxon(record('Edgeus exactus', [1, 367]), LIST).state, 'shown');
  assert.deepEqual(placeTaxon(record('Edgeus below', [1, 367]), LIST), { state: 'tiles-disagree', group: 'Arachnida', iou: 0.6999, month: 'September 2026' });
  assert.equal(placeTaxon(record('Stemonitis fusca', [1, 367]), LIST).state, 'tiles-disagree');
  assert.equal(placeTaxon(record('Uncheckus nullus', [1, 367]), LIST).state, 'unchecked');
});

test('placeTaxon: a species outside the list is placed in its collection from its GBIF lineage, exclusions honoured', () => {
  // a bird is in Aves (failed) and not in OtherAnimalia, which includes all animals but excludes birds
  assert.deepEqual(placeTaxon(record('Anser cygnoides', [1, 44, 212, 1108]), LIST), { state: 'group-failed', group: 'Aves', month: 'September 2026' });
  assert.deepEqual(placeTaxon(record('Lumbricus terrestris', [1, 42]), LIST), { state: 'group-failed', group: 'OtherAnimalia', month: 'September 2026' });
  assert.equal(placeTaxon(record('Amanita muscaria', [5, 34]), LIST).state, 'group-insufficient');
  // a passing collection, but the model has no species under this name (a synonym, or not modeled)
  assert.deepEqual(placeTaxon(record('Araneus unlistedus', [1, 54, 367]), LIST), { state: 'not-in-model', group: 'Arachnida', month: 'September 2026' });
  // in no collection at all (bacteria)
  assert.deepEqual(placeTaxon(record('Escherichia coli', [3, 1234]), LIST), { state: 'not-in-model', group: null, month: 'September 2026' });
});

test('placeTaxon: above species rank there is no range; with no list the card says so', () => {
  assert.equal(placeTaxon({ ...SPIDER, rank: 'GENUS' }, LIST).state, 'not-species');
  assert.deepEqual(placeTaxon(SPIDER, null), { state: 'no-list' });
});

test('modeledNote: every state reads as a reason, never blank; the shown note names source and validation', () => {
  const place = (state, extra = {}) => ({ state, group: 'Aves', month: 'September 2026', ...extra });
  assert.equal(modeledNote(place('shown', { group: 'Arachnida', check: 'full' })), 'iNaturalist Geomodel · Arachnida passed validation September 2026');
  assert.equal(modeledNote(place('shown', { group: 'Arachnida', check: 'skim' })), 'iNaturalist Geomodel · Arachnida passed validation September 2026 · map spot-checked');
  assert.equal(modeledNote(place('group-failed')), 'No modeled range: Aves failed validation (September 2026)');
  assert.equal(modeledNote(place('group-insufficient', { group: 'Fungi' })), 'No modeled range: too few Fungi species could be tested (September 2026)');
  assert.equal(modeledNote(place('tiles-disagree', { group: 'Arachnida', iou: 0.14 })), "No modeled range: iNaturalist's map tiles differ from the range that was tested (overlap 0.14)");
  assert.equal(modeledNote(place('unchecked')), "No modeled range: its map tiles couldn't be checked this month");
  assert.equal(modeledNote(place('not-in-model')), "No modeled range: not in iNaturalist's geomodel under this name");
  assert.equal(modeledNote(place('not-species')), 'No modeled range: only species have one');
  assert.equal(modeledNote({ state: 'no-list', error: 'HTTP 404' }), 'Modeled ranges unavailable: the validation list failed to load (HTTP 404)');
  assert.equal(modeledNote({ state: 'loading' }), 'Checking for a modeled range…');
  assert.equal(modeledNote({ state: 'lookup-failed', error: 'HTTP 503' }), 'No modeled range: GBIF lookup failed (HTTP 503)');
  assert.throws(() => modeledNote({ state: 'bogus' }), /unknown modeled-range state bogus/);
});

test('validationMonth reads the UTC month of the verdicts', () => {
  assert.equal(validationMonth('2026-09-30T23:59:59+00:00'), 'September 2026');
  assert.equal(validationMonth('2026-10-01T00:30:00+00:00'), 'October 2026');
  assert.throws(() => validationMonth('not a date'), /verdicts date/);
});

test('loadModeledList fetches the list once and rejects loudly on HTTP errors', async () => {
  const urls = [];
  const load = loadModeledList({ fetchImpl: async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => LIST }; } });
  assert.equal((await load()).species_iou_min, 0.7);
  await load();
  assert.deepEqual(urls, ['data/geomodel_species.json']);
  let fail = true;
  const retrying = loadModeledList({ fetchImpl: async () => (fail ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => LIST }) });
  await assert.rejects(retrying(), /HTTP 404/);
  fail = false;
  assert.equal((await retrying()).species_iou_min, 0.7); // a failure is forgotten, so a later pick retries
});

function fakeImageryLayers() {
  return {
    list: [],
    add(layer) { this.list.push(layer); },
    remove(layer, destroy) { this.list = this.list.filter((x) => x !== layer); if (destroy) layer.destroyed = true; return true; },
  };
}

function rig({ pixel = [0, 0, 0, 0], pixelError = null } = {}) {
  const providers = [];
  const stacked = [];
  const scheduler = { requestsByServer: {} };
  const reads = [];
  const layer = createModeledRangeLayer({
    providerFor: (url, options) => {
      const listeners = [];
      const provider = { url, options, errorEvent: { addEventListener: (fn) => listeners.push(fn) }, fail: (error) => listeners.forEach((fn) => fn({ error })) };
      providers.push(provider);
      return provider;
    },
    imageryLayerFor: (provider, options) => ({ provider, alpha: options.alpha, show: true }),
    stack: (layers, id, imagery, zrank) => stacked.push({ id, imagery, zrank }),
    scheduler,
    readTilePixel: async (url, px, py) => { reads.push({ url, px, py }); if (pixelError) throw pixelError; return { rgba: pixel }; },
  });
  const viewer = { imageryLayers: fakeImageryLayers() };
  layer.init(viewer);
  return { layer, viewer, providers, stacked, scheduler, reads };
}

const SHOWN = { id: 298342, name: 'Trachelas pacificus', group: 'Arachnida', month: 'September 2026' };

test('layer: iNaturalist thresholded tiles at z <= 3, 512 px, credited, under the species records, 2 requests in flight', () => {
  const { layer, viewer, providers, stacked, scheduler } = rig();
  assert.equal(scheduler.requestsByServer[INAT_TILE_SERVER], INAT_MAX_IN_FLIGHT);
  assert.equal(INAT_TILE_SERVER, 'api.inaturalist.org:443');
  assert.equal(INAT_MAX_IN_FLIGHT, 2);
  assert.equal(viewer.imageryLayers.list.length, 0); // nothing until a species is shown
  layer.setTaxon(SHOWN);
  layer.setEnabled(true);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].url, 'https://api.inaturalist.org/v2/geomodel/298342/{z}/{x}/{y}.png?thresholded=true');
  assert.equal(providers[0].url, modeledTileTemplate(298342));
  assert.equal(providers[0].options.maximumLevel, MODELED_MAX_LEVEL);
  assert.equal(MODELED_MAX_LEVEL, 3);
  assert.equal(providers[0].options.tileWidth, 512);
  assert.match(providers[0].options.credit, /iNaturalist Geomodel, CC BY 4\.0/);
  const [imagery] = viewer.imageryLayers.list;
  assert.equal(imagery.alpha, MODELED_ALPHA);
  assert.equal(imagery.show, true);
  assert.deepEqual(stacked.at(-1), { id: 'modeled-range', imagery, zrank: MODELED_ZRANK });
  assert.ok(MODELED_ZRANK < SPECIES_ZRANK, 'the field draws under the species records');
  layer.setEnabled(false);
  assert.equal(viewer.imageryLayers.list.length, 0, 'off removes the layer, so it requests no tiles');
  layer.setEnabled(true);
  layer.setTaxon(null);
  assert.equal(viewer.imageryLayers.list.length, 0);
  assert.equal(layer.isEnabled(), false, 'a new species starts with the switch off');
});

test('layer: a 429 is reported at once; other failures only at the shared limit', () => {
  const { layer, providers } = rig();
  let notified = 0;
  layer.onStatus(() => { notified += 1; });
  layer.setTaxon(SHOWN);
  layer.setEnabled(true);
  const originalError = console.error;
  console.error = () => {};
  try {
    providers[0].fail(new Cesium.RequestErrorEvent(500));
    assert.equal(layer.getStatus().error, null); // positive control: one 500 is not yet a failure
    providers[0].fail(new Cesium.RequestErrorEvent(429));
    assert.equal(layer.getStatus().error, THROTTLED_MESSAGE);
    assert.equal(THROTTLED_MESSAGE, 'iNaturalist is limiting map requests — try again in a minute');
    assert.ok(notified >= 1);
    layer.setTaxon(SHOWN); // a new species clears the error
    layer.setEnabled(true);
    assert.equal(layer.getStatus().error, null);
    for (let i = 0; i < TILE_FAILURE_LIMIT; i += 1) providers.at(-1).fail(new Cesium.RequestErrorEvent(500));
    assert.equal(layer.getStatus().error, 'map tiles failing');
  } finally {
    console.error = originalError;
  }
});

test('layer: the readout reads one pixel of the z3 tile under the point; drawn = inside', async () => {
  const inside = rig({ pixel: [120, 60, 200, 180] });
  assert.equal(await inside.layer.readoutAt(0, 0), null, 'off: no row');
  inside.layer.setTaxon(SHOWN);
  inside.layer.setEnabled(true);
  const row = await inside.layer.readoutAt(47.6, -122.3);
  assert.deepEqual(inside.reads, [{ url: 'https://api.inaturalist.org/v2/geomodel/298342/3/1/2.png?thresholded=true', px: 144, py: 406 }]);
  assert.equal(row.status, 'class');
  assert.equal(row.text, 'Inside modeled range — expected nearby');
  assert.equal(row.date, 'Arachnida passed validation September 2026');
  assert.match(row.name, /Trachelas pacificus.*iNaturalist Geomodel/);
  const outside = rig({ pixel: [0, 0, 0, 0] });
  outside.layer.setTaxon(SHOWN);
  outside.layer.setEnabled(true);
  assert.equal((await outside.layer.readoutAt(47.6, -122.3)).text, 'Outside modeled range');
  const failing = rig({ pixelError: new Error('tile HTTP 429') });
  failing.layer.setTaxon(SHOWN);
  failing.layer.setEnabled(true);
  const originalError = console.error;
  console.error = () => {};
  try {
    const bad = await failing.layer.readoutAt(47.6, -122.3);
    assert.equal(bad.status, 'error');
    assert.match(bad.error, /429/);
  } finally {
    console.error = originalError;
  }
});

test('credits: the attribution lightbox and DATA_SOURCES.md name the geomodel, its licence and the tiles fetched', async () => {
  const { readFileSync } = await import('node:fs');
  const { DATA_CREDITS } = await import('./dataCredits.js');
  const credit = DATA_CREDITS.find((c) => c.key === 'modeled-range');
  assert.ok(credit, 'DATA_CREDITS has a modeled-range entry');
  assert.match(credit.html, /iNaturalist Geomodel/);
  assert.match(credit.html, /CC BY 4\.0/);
  const sources = readFileSync(new URL('../../DATA_SOURCES.md', import.meta.url), 'utf8').split('\n');
  const row = sources.find((line) => line.startsWith('| Modeled range'));
  assert.ok(row, 'DATA_SOURCES.md has a Modeled range row');
  for (const needle of ['`/v2/geomodel/{taxon}/{z}/{x}/{y}.png?thresholded=true`', '`public/data/geomodel_species.json`', 'CC BY 4.0', MODELED_CREDIT]) {
    assert.ok(row.includes(needle), `the row names ${needle}`);
  }
});
