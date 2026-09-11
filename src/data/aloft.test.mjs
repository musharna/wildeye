// src/data/aloft.test.mjs — layer contract for the Aloft European profile layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAloftLayer } from './aloft.js';
import { columnEntity } from './birds.js';

test('aloft: layer contract', () => {
  const l = createAloftLayer();
  assert.equal(l.id, 'aloft');
  for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords']) assert.equal(typeof l[k], 'function');
  assert.deepEqual(l.getAnalystRecords(), []);
});

test('columnEntity: shared renderer keys by prefix and carries properties', () => {
  const f = { type: 'Feature', geometry: { type: 'Point', coordinates: [12.85, 56.37] },
    properties: { site: 'seang', density_birds_km3: 5.3, heading_deg: 200 } };
  const e = columnEntity(f, 'aloft', () => 'x');
  assert.equal(e.id, 'aloft:seang');
  assert.equal(e.properties.lat, 56.37);
  assert.ok(e.cylinder.length > 500);
  const q = columnEntity({ ...f, properties: { site: 'q', density_birds_km3: null } }, 'aloft', () => 'x');
  assert.equal(q.cylinder.length, 500);
});
