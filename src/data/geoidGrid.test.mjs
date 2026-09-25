// src/data/geoidGrid.test.mjs — the bundled 0.5° EGM96 grid against the 15'
// grid it was resampled from (egm96-universal, now a devDependency).
//
// The app ships src/data/egm96Grid.generated.js instead of the package so the
// HUD's first-load geoid fetch is 0.69 MB, not 2.77 MB. These tests pin the
// two things that trade can get wrong: accuracy against the source grid, and
// a committed module that no longer matches its generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { meanSeaLevel } from 'egm96-universal';
import { ensureGeoidReady, geoidHeight } from './geoid.js';
import { OUTPUT, renderGridModule } from '../../scripts/build-geoid-grid.mjs';

/** Measured at 200 000 points when the grid was generated: p99 0.489 m, max 1.086 m. */
const P99_LIMIT_M = 0.6;
const MAX_LIMIT_M = 1.2;

test('the 0.5° grid stays within ~1 m of the 15′ EGM96 grid everywhere', async () => {
  await ensureGeoidReady();
  // Fixed-seed LCG, area-uniform in latitude, so every run samples the same points.
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const errors = [];
  for (let k = 0; k < 50_000; k += 1) {
    const lat = (Math.asin(2 * next() - 1) * 180) / Math.PI;
    const lon = -180 + 360 * next();
    errors.push(Math.abs(geoidHeight(lat, lon) - meanSeaLevel(lat, lon)));
  }
  errors.sort((a, b) => a - b);
  const p99 = errors[Math.floor(errors.length * 0.99)];
  const max = errors.at(-1);
  assert.ok(p99 <= P99_LIMIT_M, `p99 error ${p99.toFixed(3)} m exceeds ${P99_LIMIT_M} m`);
  assert.ok(max <= MAX_LIMIT_M, `max error ${max.toFixed(3)} m exceeds ${MAX_LIMIT_M} m`);
});

test('the grid edges agree with the source: poles, the antimeridian and its seam', async () => {
  await ensureGeoidReady();
  for (const [lat, lon] of [[90, 0], [-90, 0], [0, 180], [0, -180], [45, 179.9], [45, -179.9], [-89.9, 10]]) {
    const n = geoidHeight(lat, lon);
    assert.ok(Number.isFinite(n), `geoidHeight(${lat}, ${lon}) = ${n}`);
    assert.ok(Math.abs(n - meanSeaLevel(lat, lon)) <= MAX_LIMIT_M, `edge (${lat}, ${lon}): ${n} vs ${meanSeaLevel(lat, lon)}`);
  }
});

test('the antimeridian is continuous: approaching ±180° from either side gives one value', async () => {
  // ±180 itself normalizes to -180 on both sides, so it cannot test the seam.
  // Just inside each edge reads grid column 720 (lon +180) on the east side and
  // column 0 (lon -180) on the west, so this fails if the two edge columns disagree.
  await ensureGeoidReady();
  const EDGE = 180 - 1e-6;
  let worst = 0;
  for (let lat = -89.75; lat <= 89.75; lat += 0.25) {
    worst = Math.max(worst, Math.abs(geoidHeight(lat, EDGE) - geoidHeight(lat, -EDGE)));
  }
  // Positive control: the seam check is not comparing a number to itself.
  assert.notEqual(geoidHeight(45, EDGE), geoidHeight(45, -EDGE + 0.5));
  assert.ok(worst < 1e-3, `seam discontinuity ${worst.toFixed(4)} m`);
});

test('the committed grid module is exactly what the generator produces', () => {
  assert.equal(
    readFileSync(OUTPUT, 'utf8') === renderGridModule(),
    true,
    'src/data/egm96Grid.generated.js is stale: run npm run build:geoid-grid',
  );
});
