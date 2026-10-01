// src/data/effort.test.mjs — the RECORDING EFFORT layer: GBIF hexagons of every record of the chosen species' class.
// Spec: docs/superpowers/specs/2026-09-30-effort-layer-design.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { effortNote, effortClassName, createEffortLayer, EFFORT_ZRANK, EFFORT_ALPHA, EFFORT_CREDIT } from './effort.js';
import { MODELED_ZRANK } from './modeledRange.js';
import { SPECIES_ZRANK, TILE_FAILURE_LIMIT } from './species.js';

const NOW = new Date('2026-09-30T12:00:00Z');

test('effortClassName: a geomodel collection\'s class in plain words, any other class by its GBIF name', () => {
  assert.equal(effortClassName('Arachnida'), 'spiders and other arachnids');
  assert.equal(effortClassName('Aves'), 'birds');
  assert.equal(effortClassName('Insecta'), 'insects');
  assert.equal(effortClassName('Magnoliopsida'), 'class Magnoliopsida');
  assert.throws(() => effortClassName(null), /class name/);
});

test('effortNote: says what is counted, from where, over which years, and how to read the colours; every state reads as a sentence', () => {
  const shown = (years) => effortNote({ state: 'shown', className: 'Arachnida', years, now: NOW });
  assert.equal(shown('recent'), 'Where anyone recorded spiders and other arachnids · GBIF CC0/CC BY, 2017–2026 · purple few, white many');
  assert.equal(shown('all'), 'Where anyone recorded spiders and other arachnids · GBIF CC0/CC BY, all years · purple few, white many');
  assert.equal(effortNote({ state: 'loading' }), 'Checking for an effort map…');
  assert.equal(effortNote({ state: 'no-class' }), 'No effort map: GBIF lists no class for this species');
  assert.equal(effortNote({ state: 'lookup-failed', error: 'HTTP 503' }), 'No effort map: GBIF lookup failed (HTTP 503)');
  assert.throws(() => effortNote({ state: 'bogus' }), /unknown effort state bogus/);
});

function rig() {
  const providers = [];
  const stacked = [];
  const layer = createEffortLayer({
    providerFor: (url, options) => {
      const fns = [];
      const provider = { url, options, errorEvent: { addEventListener: (fn) => fns.push(fn) }, fail: (error) => fns.forEach((fn) => fn({ error })) };
      providers.push(provider);
      return provider;
    },
    imageryLayerFor: (provider, options) => ({ provider, ...options }),
    stack: (layers, id, imagery, zrank) => stacked.push({ id, imagery, zrank }),
    now: () => NOW,
  });
  const viewer = { imageryLayers: { list: [], add(l) { this.list.push(l); }, remove(l) { this.list = this.list.filter((x) => x !== l); } } };
  layer.init(viewer);
  return { layer, providers, stacked, viewer };
}

test('effort layer: off asks for nothing; on draws the class\'s tiles under the modeled range and the species records', () => {
  const { layer, providers, stacked, viewer } = rig();
  layer.setTaxon({ classKey: 367, className: 'Arachnida' });
  assert.equal(providers.length, 0, 'off by default: no provider, no tiles');
  assert.equal(viewer.imageryLayers.list.length, 0);
  layer.setEnabled(true);
  assert.equal(providers.length, 1);
  const url = new URL(providers[0].url.replace('{z}/{x}/{y}', '0/0/0'));
  assert.equal(url.searchParams.get('taxonKey'), '367');
  assert.equal(url.searchParams.get('year'), '2017,2026', 'the species map\'s default years');
  assert.equal(providers[0].options.credit, EFFORT_CREDIT);
  assert.equal(viewer.imageryLayers.list.length, 1);
  assert.equal(viewer.imageryLayers.list[0].alpha, EFFORT_ALPHA);
  assert.ok(EFFORT_ZRANK < MODELED_ZRANK && MODELED_ZRANK < SPECIES_ZRANK, 'effort under the modeled range, under the records');
  assert.deepEqual(stacked.at(-1), { id: 'effort', imagery: viewer.imageryLayers.list[0], zrank: EFFORT_ZRANK });
  layer.setEnabled(false);
  assert.equal(viewer.imageryLayers.list.length, 0, 'off removes the layer');
});

test('effort layer: a change of years redraws in the new years while on, and only remembers them while off', () => {
  const { layer, providers } = rig();
  layer.setTaxon({ classKey: 212, className: 'Aves' });
  layer.setYears('all');
  assert.equal(providers.length, 0);
  layer.setEnabled(true);
  assert.equal(new URL(providers[0].url.replace('{z}/{x}/{y}', '0/0/0')).searchParams.has('year'), false);
  layer.setYears('recent');
  assert.equal(providers.length, 2);
  assert.equal(new URL(providers[1].url.replace('{z}/{x}/{y}', '0/0/0')).searchParams.get('year'), '2017,2026');
  assert.equal(layer.getStatus().years, 'recent');
  assert.throws(() => layer.setYears('decade'), /years/);
});

test('effort layer: a new species switches it off; no species, nothing to switch on', () => {
  const { layer, viewer } = rig();
  layer.setTaxon({ classKey: 367, className: 'Arachnida' });
  layer.setEnabled(true);
  layer.setTaxon({ classKey: 212, className: 'Aves' });
  assert.equal(layer.isEnabled(), false);
  assert.equal(viewer.imageryLayers.list.length, 0);
  layer.setTaxon(null);
  layer.setEnabled(true);
  assert.equal(layer.isEnabled(), false);
});

test('effort layer: failing tiles are said, never a quiet blank; a redraw clears the error', () => {
  const { layer, providers } = rig();
  let notified = 0;
  layer.onStatus(() => { notified += 1; });
  layer.setTaxon({ classKey: 367, className: 'Arachnida' });
  layer.setEnabled(true);
  for (let i = 0; i < TILE_FAILURE_LIMIT - 1; i += 1) providers[0].fail(new Cesium.RequestErrorEvent(500));
  assert.equal(layer.getStatus().error, null, 'below the limit: no message yet');
  providers[0].fail(new Cesium.RequestErrorEvent(500));
  assert.equal(layer.getStatus().error, 'map tiles failing');
  assert.ok(notified > 0);
  providers[0].fail(new Error('not a request error'));
  assert.equal(layer.getStatus().error, 'map tiles failing');
  layer.setYears('all');
  assert.equal(layer.getStatus().error, null);
  // an old provider's failures do not count against the new one
  for (let i = 0; i < TILE_FAILURE_LIMIT; i += 1) providers[0].fail(new Cesium.RequestErrorEvent(500));
  assert.equal(layer.getStatus().error, null);
});
