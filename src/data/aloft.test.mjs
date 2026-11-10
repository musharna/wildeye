// src/data/aloft.test.mjs — layer contract for the Aloft European profile layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAloftLayer, describeAloft } from './aloft.js';
import { columnEntity } from './birds.js';

test('aloft: layer contract', () => {
  const l = createAloftLayer();
  assert.equal(l.id, 'aloft');
  for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords']) assert.equal(typeof l[k], 'function');
  assert.deepEqual(l.getAnalystRecords(), []);
});

test('aloft: the profile time cannot wrap inside its date', () => {
  const p = { site: 'seang', name: 'Angelholm', density_birds_km3: 5.3, heading_deg: 200, speed_ms: 8, peak_altitude_m: 400,
    scan_time: '2026-10-15T20:09:42Z' };
  assert.match(describeAloft(p, 6000), /<br>profile Oct\u00a015\u00a020:09\u00a0UTC · published daily/);
  assert.doesNotMatch(describeAloft(p, 6000), /\d-\d/);
  assert.match(describeAloft({ ...p, peak_altitude_m: 0 }, 6000), /8 m\/s, densest 0\u2060–\u2060200\u00a0m above sea level<br>/);
});

test('aloft: a stale profile says so in its popup, a current one does not', () => {
  // the pipeline marks a radar stale when its newest profile is over 4 days 6 h old (pipeline/aloft.py STALE_AFTER);
  // the column already faded, but the popup read like any other
  const p = { site: 'iltlv', name: 'ILTLV', density_birds_km3: 0.4, heading_deg: 10, speed_ms: 3, peak_altitude_m: 0,
    scan_time: '2025-05-04T07:55:02Z' };
  assert.match(describeAloft({ ...p, stale: true }, 600), /<br>profile May\u00a04\u00a007:55\u00a0UTC \(stale: no newer profile\) · published daily/);
  assert.doesNotMatch(describeAloft({ ...p, stale: false }, 600), /stale/);
  assert.doesNotMatch(describeAloft(p, 600), /stale/);
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
