import test from 'node:test';
import assert from 'node:assert/strict';
import { POOLED_SORT_RUN, sortPooledRange } from './pooledSort.js';

/** Deterministic 32-bit LCG so every case is reproducible. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Few distinct keys, so ties are common and stability is actually exercised.
function makeItems(count, random) {
  return Array.from({ length: count }, (_, index) => ({ key: Math.floor(random() * 7), index }));
}

function countingCompare() {
  const compare = (a, b) => {
    compare.calls++;
    return a.key - b.key;
  };
  compare.calls = 0;
  return compare;
}

test('sorts the live prefix stably and leaves the pooled tail untouched', () => {
  const random = makeRandom(20260924);
  const sizes = [0, 1, 2, POOLED_SORT_RUN - 1, POOLED_SORT_RUN, POOLED_SORT_RUN + 1, 2 * POOLED_SORT_RUN + 1, 350, 1000];
  for (const count of sizes) {
    const items = makeItems(count, random);
    const tail = [{ key: -1, index: -1 }, { key: -2, index: -2 }];
    const pooled = [...items, ...tail];
    // V8's Array#sort is stable (ES2019), so it is the reference order.
    const expected = items.slice().sort((a, b) => a.key - b.key);
    sortPooledRange(pooled, count, (a, b) => a.key - b.key);
    assert.deepEqual(pooled.slice(0, count), expected, `count ${count}`);
    assert.equal(pooled[count], tail[0], `count ${count}: tail moved`);
    assert.equal(pooled[count + 1], tail[1], `count ${count}: tail moved`);
  }
});

test('comparison count is O(n log n) on disordered input and O(n) on sorted input', () => {
  // ~350 painted items is the all-live frame measured on 2026-09-24; the
  // insertion sort this replaced spent ~n²/4 ≈ 30k comparisons on it.
  const count = 350;
  const shuffled = makeItems(count, makeRandom(7));
  const disordered = countingCompare();
  sortPooledRange(shuffled, count, disordered);
  assert.ok(disordered.calls <= 6000, `disordered input took ${disordered.calls} comparisons`);

  const sorted = shuffled.slice();
  const presorted = countingCompare();
  sortPooledRange(sorted, count, presorted);
  assert.ok(presorted.calls <= 2 * count, `sorted input took ${presorted.calls} comparisons`);
  assert.deepEqual(sorted, shuffled);
});
