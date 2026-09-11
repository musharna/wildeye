// src/data/birds.test.mjs — pure helpers + layer contract for the radar bird layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBirdRecord, birdColumn, headingColor, createBirdsLayer, drapeFade } from './birds.js';

test('birds: analyst record maps fields and nulls', () => {
  const r = mapBirdRecord({ site: 'KOKX', name: 'Upton NY', density_birds_km3: 12.5, heading_deg: 200, speed_ms: 9, peak_altitude_m: 600, scan_time: '2026-09-11T00:12:10Z', stale: false, lat: 40.9, lon: -72.9 }, 0);
  assert.deepEqual(r, { id: 'KOKX', name: 'Upton NY', densityBirdsKm3: 12.5, headingDeg: 200, speedMs: 9, peakAltitudeM: 600, scanTime: '2026-09-11T00:12:10Z', stale: false, lat: 40.9, lon: -72.9 });
  const n = mapBirdRecord({ density_birds_km3: NaN }, 4);
  assert.equal(n.id, 'RADAR-0004');
  assert.equal(n.densityBirdsKm3, null);
});

test('birds: column height is monotone, floored, capped', () => {
  assert.equal(birdColumn(null), 0);
  assert.equal(birdColumn(0), 0);
  assert.ok(birdColumn(1) < birdColumn(50));
  assert.ok(birdColumn(1e6) <= 120000);
});

test('birds: heading colour is defined for nulls', () => {
  assert.ok(headingColor(null));
  assert.notDeepEqual(headingColor(0), headingColor(180));
});

test('birds: layer contract', () => {
  const l = createBirdsLayer();
  assert.equal(l.id, 'birds');
  for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords']) assert.equal(typeof l[k], 'function');
  assert.deepEqual(l.getAnalystRecords(), []);
  assert.equal(l.getStats().particles, 0);
  assert.equal(l.getStats().drapes, 0);
});

test('birds: drape fade is 1 near, 0 far, monotone between', () => {
  assert.equal(drapeFade(100000), 1);
  assert.equal(drapeFade(3000000), 0);
  const mid = drapeFade(1400000);
  assert.ok(mid > 0 && mid < 1);
  assert.ok(drapeFade(1000000) > drapeFade(1800000));
});

test('birds: component params toggle and drive row chips', () => {
  const l = createBirdsLayer();
  assert.deepEqual(l.getParams(), { columns: false, drape: true, particles: true });
  assert.equal(l.setParams({ drape: false }), true);
  assert.equal(l.setParams({ drape: false }), false);
  assert.equal(l.setParams({ drape: 'no' }), false);
  const chips = l.getRowControls().chips;
  const drape = chips.find((c) => c.id === 'drape');
  assert.equal(drape.active, false);
  assert.deepEqual(drape.params, { drape: true });
  assert.equal(chips.length, 3);
});

test('birds: replay mode gate — update() is a no-op in replay and live resumes', async () => {
  const l = createBirdsLayer();
  assert.equal(l.getMode(), 'live');
  assert.equal(l.getStats().mode, 'live');
  assert.equal(l.getReplayInfo(), null);
});
