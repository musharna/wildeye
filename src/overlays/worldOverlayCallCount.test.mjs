import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  aggregateCoverage,
  compareToBaseline,
  totalCalls,
} from '../../scripts/callcount-check.mjs';

/**
 * The world-overlay frame's exact src/ call counts must equal the committed
 * baseline (`scripts/callcount-baseline.json`). Counts are deterministic across
 * runs, host load and Node versions, so there is no headroom and no runtime
 * skip: any change in work is a red build until the baseline is re-committed.
 */

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/callcount-check.mjs', import.meta.url));

function baselineOf(total, functions) {
  return { workloads: { frame: { total, functions } } };
}

test('ratchet verdicts: equal passes, and a rise, a drop or a missing row each fail by name', () => {
  const counts = { 'src/a.js:paint': 10, 'src/a.js:measure': 5 };
  const [equal] = compareToBaseline(baselineOf(15, counts), { frame: counts });
  assert.equal(equal.verdict, 'equal');
  assert.deepEqual(equal.deltas, []);

  const [rose] = compareToBaseline(baselineOf(15, counts), { frame: { ...counts, 'src/a.js:paint': 11 } });
  assert.equal(rose.verdict, 'regressed');
  assert.deepEqual(rose.deltas, [{ key: 'src/a.js:paint', delta: 1 }]);

  const [dropped] = compareToBaseline(baselineOf(15, counts), { frame: { 'src/a.js:paint': 10, 'src/a.js:measure': 4 } });
  assert.equal(dropped.verdict, 'improved');
  assert.deepEqual(dropped.deltas, [{ key: 'src/a.js:measure', delta: -1 }]);

  const [missing] = compareToBaseline({ workloads: {} }, { frame: counts });
  assert.equal(missing.verdict, 'missing');
});

test('coverage aggregation keeps only called src/ functions, keyed by name', () => {
  const scripts = [
    {
      url: 'file:///repo/src/overlays/worldOverlay.js',
      functions: [
        { functionName: '', ranges: [{ count: 1 }] },
        { functionName: 'paint', ranges: [{ count: 7 }, { count: 2 }] },
        { functionName: 'paint', ranges: [{ count: 3 }] },
        { functionName: 'neverCalled', ranges: [{ count: 0 }] },
        { functionName: '', ranges: [{ count: 4 }] },
      ],
    },
    { url: 'file:///repo/node_modules/cesium/src/Core.js', functions: [{ functionName: 'x', ranges: [{ count: 99 }] }] },
    { url: 'node:internal/modules/run_main', functions: [{ functionName: 'y', ranges: [{ count: 99 }] }] },
  ];
  // Only the function-level (first) range is an invocation count; later
  // ranges are block counts and must not be added.
  assert.deepEqual(aggregateCoverage(scripts), {
    'src/overlays/worldOverlay.js:(anonymous)': 5,
    'src/overlays/worldOverlay.js:paint': 10,
  });
  assert.equal(totalCalls(aggregateCoverage(scripts)), 15);
});

test('world-overlay frame call counts equal the committed baseline', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--json'], { encoding: 'utf8', timeout: 600_000 });
  if (result.error) throw new Error(`callcount-check failed to spawn: ${result.error.message}`);
  const rows = result.stdout.trim() ? JSON.parse(result.stdout.trim().split('\n').pop()) : [];
  const summary = rows.map((row) => `${row.name}: ${row.verdict} ${row.current} vs ${row.baseline}`
    + row.deltas.map(({ key, delta }) => `\n  ${delta > 0 ? '+' : ''}${delta} ${key}`).join('')).join('\n');
  assert.equal(result.status, 0, `${summary}\n${result.stderr}`);
  assert.ok(rows.length >= 3, result.stdout);
  for (const row of rows) assert.equal(row.verdict, 'equal', summary);
});
