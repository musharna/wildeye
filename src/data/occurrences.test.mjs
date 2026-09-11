// src/data/occurrences.test.mjs — GBIF/OBIS sightings layer: pure helpers + contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOccurrencesLayer, ageAlpha, pointEntity, describeOccurrence, GROUP_COLORS } from './occurrences.js';

const NOW = Date.parse('2026-09-11T00:00:00Z');

test('ageAlpha: today bright, window-old faded, garbage faded', () => {
  assert.equal(ageAlpha('2026-09-11', NOW), 1);
  assert.ok(Math.abs(ageAlpha('2026-07-13', NOW) - 0.625) < 0.01);   // 60 of 120 days
  assert.equal(ageAlpha('2026-01-01', NOW), 0.25);
  assert.equal(ageAlpha('nope', NOW), 0.25);
});

test('pointEntity: id is stable, colour by group, age drives alpha', () => {
  const f = { type: 'Feature', geometry: { type: 'Point', coordinates: [-53.09, 48.7] },
    properties: { taxon: 'humpback', name: 'Humpback whale', sci: 'Megaptera novaeangliae', group: 'whales', icon: '🐋',
      date: '2026-09-11', source: 'obis', license: 'https://creativecommons.org/publicdomain/zero/1.0/', basis: 'HumanObservation' } };
  const e = pointEntity(f, NOW);
  assert.equal(e.id, 'occ:humpback:-53.0900:48.7000:2026-09-11');
  assert.equal(e.point.color.alpha, 1);
  assert.equal(e.properties.lat, 48.7);
  const old = pointEntity({ ...f, properties: { ...f.properties, date: '2026-01-01', group: 'zzz' } }, NOW);
  assert.equal(old.point.color.alpha, 0.25);
  assert.ok(Object.keys(GROUP_COLORS).includes('whales'));
  assert.match(describeOccurrence(f.properties), /Humpback whale.*CC0/s);
});

test('occurrences: layer contract and group chips', () => {
  const l = createOccurrencesLayer();
  assert.equal(l.id, 'occurrences');
  for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setParams', 'getParams'])
    assert.equal(typeof l[k], 'function');
  assert.deepEqual(l.getAnalystRecords(), []);
  assert.deepEqual(l.getRowControls().chips, []);
  assert.equal(l.setParams({ whales: false }), false);   // unknown group before any data: no-op
});
