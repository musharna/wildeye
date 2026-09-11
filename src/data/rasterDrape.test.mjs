// src/data/rasterDrape.test.mjs — manifest selection + layer contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickProduct, createRasterDrapeLayer, crwBleachingLayer, oisstLayer } from './rasterDrape.js';

test('pickProduct: finds by id, null when absent or malformed', () => {
  const m = { products: [{ id: 'a', png: 'x' }, { id: 'b' }] };
  assert.deepEqual(pickProduct(m, 'a'), { id: 'a', png: 'x' });
  assert.equal(pickProduct(m, 'zzz'), null);
  assert.equal(pickProduct({}, 'a'), null);
  assert.equal(pickProduct(null, 'a'), null);
});

test('raster drape: contract and ids', () => {
  for (const l of [crwBleachingLayer, oisstLayer, createRasterDrapeLayer({ id: 't', name: 't', icon: 'x', source: 's' })]) {
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getRowControls']) assert.equal(typeof l[k], 'function');
    assert.equal(l.getStats().count, 0);
  }
  assert.equal(crwBleachingLayer.id, 'crw-bleaching');
  assert.equal(oisstLayer.id, 'oisst');
});
