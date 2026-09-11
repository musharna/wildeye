// src/data/birdsField.test.mjs — pure helpers for the radar particle field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpawnCdf, sampleCell, idwVelocity, stepParticle, birdsPerParticle } from './birdsField.js';

function rgba(vals) { const a = new Uint8ClampedArray(vals.length * 4); vals.forEach((v, i) => { a[i * 4] = v; a[i * 4 + 3] = v ? 255 : 0; }); return a; }

test('spawn cdf: total equals sum of intensities and zero cells are never sampled', () => {
  const { cdf, total } = buildSpawnCdf(rgba([0, 10, 0, 30]), 2, 2);
  assert.equal(total, 40);
  assert.equal(cdf.length, 4);
  const hits = new Set();
  for (let u = 0; u < 1; u += 0.001) hits.add(sampleCell(cdf, u));
  assert.deepEqual([...hits].sort(), [1, 3]);
  assert.equal(sampleCell(cdf, 0.999), 3);
  assert.equal(sampleCell(cdf, 0), 1);
});

test('idw: at a site position returns that site; between two equal sites averages', () => {
  const sites = [
    { lon: -80, lat: 40, u_ms: 10, v_ms: 0 },
    { lon: -78, lat: 40, u_ms: 0, v_ms: 10 },
    { lon: -70, lat: 30, u_ms: -50, v_ms: -50 },
  ];
  assert.deepEqual(idwVelocity(sites, -80, 40), { u: 10, v: 0 });
  const mid = idwVelocity(sites, -79, 40, 2);
  assert.ok(Math.abs(mid.u - 5) < 1e-9 && Math.abs(mid.v - 5) < 1e-9);
  assert.deepEqual(idwVelocity([], -79, 40), { u: 0, v: 0 });
});

test('step: +u moves east, +v moves north, leaving bounds marks dead', () => {
  const bounds = { west: -81, south: 39, east: -79, north: 41 };
  const p = stepParticle({ lon: -80, lat: 40, u: 10, v: 5, age: 0 }, 60, bounds, 90);
  assert.ok(p.lon > -80 && p.lat > 40 && p.age === 60 && !p.dead);
  const q = stepParticle({ lon: -79.001, lat: 40, u: 100, v: 0, age: 0 }, 60, bounds, 90);
  assert.equal(q.dead, true);
  const r = stepParticle({ lon: -80, lat: 40, u: 0, v: 0, age: 85 }, 10, bounds, 90);
  assert.equal(r.dead, true);
});

test('birdsPerParticle: density × cell volume / particles in cell', () => {
  // 0.02° cell at 40°N ≈ 2.22 km × 1.70 km ≈ 3.79 km² × 1 km depth; weight share 0.01 of 4000 = 40 particles
  const n = birdsPerParticle(100, 40, 0.02, 0.01, 4000);
  assert.ok(n > 8 && n < 11, String(n));
});
