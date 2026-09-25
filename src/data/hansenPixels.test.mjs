// src/data/hansenPixels.test.mjs — GFW tree-cover-loss data tiles: decode, observed cut-off, recolour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_YEAR, LAST_YEAR, decodeLossPixel, maxCodeFor, rampColour, recolourPixels } from './hansenPixels.js';

// Probed 2026-09-25 on …/v1.12/dynamic/12/1331/2175.png: loss pixels are (255, 0, year−2000, 255); no loss is alpha 0.
test('decodeLossPixel: blue is the loss year, alpha 0 is no loss, anything else is named', () => {
  assert.deepEqual(decodeLossPixel([255, 0, 19, 255]), { kind: 'loss', year: 2019 });
  assert.deepEqual(decodeLossPixel([255, 0, 1, 255]), { kind: 'loss', year: FIRST_YEAR });
  assert.deepEqual(decodeLossPixel([255, 0, 24, 255]), { kind: 'loss', year: LAST_YEAR });
  assert.deepEqual(decodeLossPixel([0, 0, 0, 0]), { kind: 'none' });
  // a code outside 1–24 or a non-zero green is not this encoding: named, never guessed
  assert.deepEqual(decodeLossPixel([255, 0, 25, 255]), { kind: 'unknown', rgba: [255, 0, 25, 255] });
  assert.deepEqual(decodeLossPixel([255, 0, 0, 255]), { kind: 'unknown', rgba: [255, 0, 0, 255] });
  assert.deepEqual(decodeLossPixel([255, 7, 12, 255]), { kind: 'unknown', rgba: [255, 7, 12, 255] });
});

test('maxCodeFor: the observed instant cuts loss off at its year; live and after-the-data show all', () => {
  assert.equal(maxCodeFor(null), LAST_YEAR - 2000);
  assert.equal(maxCodeFor('2010-06-01T00:00:00Z'), 10);
  assert.equal(maxCodeFor('2001-01-01T00:00:00Z'), 1);
  assert.equal(maxCodeFor('1999-12-31T00:00:00Z'), 0, 'before the first loss year nothing is drawn');
  assert.equal(maxCodeFor('2030-01-01T00:00:00Z'), LAST_YEAR - 2000);
});

test('rampColour: yellow for the first year, deep red for the last, every year distinct', () => {
  const first = rampColour(FIRST_YEAR), last = rampColour(LAST_YEAR);
  assert.ok(first[0] > 200 && first[1] > 180, `first ${first}`);
  assert.ok(last[1] < 40 && last[0] > 120, `last ${last}`);
  const seen = new Set();
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) seen.add(rampColour(y).join(','));
  assert.equal(seen.size, LAST_YEAR - FIRST_YEAR + 1);
  assert.throws(() => rampColour(2000), /2000/);
});

test('recolourPixels: loss up to the cut-off takes the ramp colour at its intensity; later loss and no loss vanish', () => {
  const d = new Uint8ClampedArray([
    255, 0, 5, 255, //  2005, full intensity
    128, 0, 10, 255, // 2010, half intensity (a zoomed-out average)
    255, 0, 20, 255, // 2020 — after the cut-off
    0, 0, 0, 0, //      no loss
  ]);
  recolourPixels(d, 12);
  assert.deepEqual([...d.slice(0, 4)], [...rampColour(2005), 255]);
  assert.deepEqual([...d.slice(4, 8)], [...rampColour(2010), 128]);
  assert.equal(d[11], 0, 'loss after the observed year is transparent');
  assert.equal(d[15], 0);
});
