// The HUD summary's locality tag: the camera's lat/lon with hemisphere suffixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeLocalityTag } from './hudLocality.js';

test('every hemisphere carries the right suffixes', () => {
  assert.equal(composeLocalityTag(-22.9068, -43.1729), '22.91S 43.17W');
  assert.equal(composeLocalityTag(21.3069, -157.8583), '21.31N 157.86W');
  assert.equal(composeLocalityTag(55.7558, 37.6173), '55.76N 37.62E');
  assert.equal(composeLocalityTag(-33.8688, 151.2093), '33.87S 151.21E');
  assert.equal(composeLocalityTag(0, 0), '0.00N 0.00E');
});

// The test above only exercises the helper. This pins the PRODUCTION wiring:
// hud.js must build its summary through it.
test('hud.js composes its summary through this helper', () => {
  const source = readFileSync(new URL('./hud.js', import.meta.url), 'utf8');
  assert.equal(
    /import \{ composeLocalityTag \} from '\.\/hudLocality\.js';/.test(source),
    true,
    'hud.js must import composeLocalityTag from ./hudLocality.js',
  );
  assert.equal(
    /const localityTag = composeLocalityTag\(m\.latDeg, m\.lonDeg\);/.test(source),
    true,
    '_composeSummary must build its locality tag through composeLocalityTag()',
  );
});
