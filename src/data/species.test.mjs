// src/data/species.test.mjs — species map layer: params, tile rebuilds, z-order above drapes, tile-failure status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeciesLayer, mergeSpeciesParams, DEFAULT_SPECIES_PARAMS, SPECIES_ALPHA, TILE_FAILURE_LIMIT } from './species.js';
import { setStackedImagery } from './rasterDrape.js';

const NOW = new Date('2026-09-13T12:00:00Z');

function fakeImageryLayers() {
  return {
    list: [],
    contains(layer) { return this.list.includes(layer); },
    add(layer) { this.list.push(layer); },
    remove(layer, destroy) { this.list = this.list.filter((x) => x !== layer); if (destroy) layer.destroyed = true; return true; },
  };
}

function harness() {
  const providers = [];
  const layer = createSpeciesLayer({
    providerFor: (url) => {
      const listeners = [];
      const provider = { url, errorEvent: { addEventListener: (fn) => listeners.push(fn) }, fail: (error) => listeners.forEach((fn) => fn({ error })) };
      providers.push(provider);
      return provider;
    },
    imageryLayerFor: (provider, options) => ({ provider, alpha: options.alpha, show: false }),
    now: () => NOW,
  });
  return { layer, viewer: { imageryLayers: fakeImageryLayers() }, providers };
}

test('params: a new taxon clears the old name; invalid values reject the whole request', () => {
  const monarch = mergeSpeciesParams(DEFAULT_SPECIES_PARAMS, { taxonKey: 5133088, name: 'Monarch' });
  assert.deepEqual(monarch, { taxonKey: 5133088, name: 'Monarch', years: 'recent', radiusKm: 10 });
  assert.equal(mergeSpeciesParams(monarch, { taxonKey: 5220086 }).name, null);
  assert.equal(mergeSpeciesParams(monarch, { radiusKm: 50 }).name, 'Monarch');
  assert.equal(mergeSpeciesParams(monarch, { years: 'decade' }), null);
  assert.equal(mergeSpeciesParams(monarch, { radiusKm: 5 }), null);
  assert.equal(mergeSpeciesParams(monarch, { taxonKey: -1 }), null);
  assert.equal(mergeSpeciesParams(monarch, { taxonKey: '5133088' }), null);
});

test('no tiles until a species is chosen; years rebuild the tiles, radius does not', () => {
  const { layer, viewer, providers } = harness();
  layer.init(viewer);
  assert.equal(providers.length, 0);
  assert.equal(layer.setParams({ taxonKey: 5133088, name: 'Monarch' }), true);
  assert.equal(providers.length, 1);
  assert.match(providers[0].url, /\/v2\/map\/occurrence\/adhoc\/\{z\}\/\{x\}\/\{y\}@1x\.png\?.*taxonKey=5133088/);
  assert.equal(viewer.imageryLayers.list.length, 1);
  assert.equal(viewer.imageryLayers.list[0].alpha, SPECIES_ALPHA);
  assert.equal(viewer.imageryLayers.list[0].show, false, 'hidden until enabled');
  layer.enable();
  assert.equal(viewer.imageryLayers.list[0].show, true);
  layer.setParams({ radiusKm: 50 });
  assert.equal(providers.length, 1, 'radius only affects what lives here');
  layer.setParams({ years: 'all' });
  assert.equal(providers.length, 2);
  assert.equal(viewer.imageryLayers.list.length, 1, 'old tiles removed');
  assert.equal(providers[1].url.includes('year='), false);
  assert.equal(layer.setParams({ years: 'decade' }), false);
  assert.deepEqual(layer.getParams(), { taxonKey: 5133088, name: 'Monarch', years: 'all', radiusKm: 50 });
  layer.destroy();
  assert.equal(viewer.imageryLayers.list.length, 0);
});

test('species tiles stay above the raster drapes after a drape restacks', () => {
  const { layer, viewer } = harness();
  layer.init(viewer);
  layer.setParams({ taxonKey: 5133088 });
  const drape = { name: 'test drape' };
  viewer.imageryLayers.add(drape);
  setStackedImagery(viewer.imageryLayers, 'test-drape', drape, 10);
  const top = viewer.imageryLayers.list[viewer.imageryLayers.list.length - 1];
  assert.equal(top.provider?.url.includes('taxonKey=5133088'), true, 'species imagery is last (drawn on top)');
  setStackedImagery(viewer.imageryLayers, 'test-drape', null);
  layer.destroy();
});

test('repeated tile errors surface "map tiles failing" once', () => {
  const { layer, viewer, providers } = harness();
  let notified = 0;
  layer.onStatus(() => { notified += 1; });
  layer.init(viewer);
  layer.setParams({ taxonKey: 5133088 });
  notified = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < TILE_FAILURE_LIMIT + 3; i += 1) providers[0].fail(new Error('HTTP 500'));
  } finally {
    console.error = originalError;
  }
  assert.equal(layer.getStats().error, 'map tiles failing');
  assert.equal(layer.getStats().tileFailures, TILE_FAILURE_LIMIT + 3);
  assert.equal(notified, 1);
  layer.destroy();
});
