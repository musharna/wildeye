// The pointer readout's one line (grill_wildeye_visual_update_2026-10-20, Q8): latitude and longitude
// in decimal degrees with hemisphere letters, replacing the four-corner camera HUD.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatLatLon } = await import('./pointerReadout.js');
const NB = ' ';

test('hemispheres follow the sign; two decimals', () => {
  assert.equal(formatLatLon(36.9812, -77.0071), `36.98°${NB}N, 77.01°${NB}W`);   // Wakefield VA (KAKQ)
  assert.equal(formatLatLon(-33.8688, 151.2093), `33.87°${NB}S, 151.21°${NB}E`); // Sydney
});

test('longitude wraps into [-180, 180)', () => {
  assert.equal(formatLatLon(10, 190), `10.00°${NB}N, 170.00°${NB}W`);
  assert.equal(formatLatLon(10, -190), `10.00°${NB}N, 170.00°${NB}E`);
  assert.equal(formatLatLon(10, 540), `10.00°${NB}N, 180.00°${NB}W`);
});

test('a value that rounds to zero takes the positive hemisphere, never "0.00° S"', () => {
  assert.equal(formatLatLon(-0.001, -0.004), `0.00°${NB}N, 0.00°${NB}E`);
  assert.equal(formatLatLon(-0.006, -0.006), `0.01°${NB}S, 0.01°${NB}W`);   // positive control: real negatives keep S/W
});

test('no position, no text', () => {
  assert.equal(formatLatLon(Number.NaN, 10), '');
  assert.equal(formatLatLon(10, Infinity), '');
  assert.equal(formatLatLon(0, 0), `0.00°${NB}N, 0.00°${NB}E`);               // positive control: zero is a position
});
