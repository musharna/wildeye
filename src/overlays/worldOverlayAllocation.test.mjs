import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isCalibratedAllocationRuntime } from '../../scripts/run-unit-tests.mjs';

/**
 * Phase-2 entry gate: a steady moving-source frame must not allocate in
 * proportion to the cohort it projects. The measurement runs in a
 * `--expose-gc` child (`worldOverlayAllocation.worker.mjs`) so the whole suite
 * does not need the flag, and the child reports GC-bracketed heap deltas over
 * ten chunks (a chunk delta is `allocated - collected`, so it can only ever
 * under-report; the median is immune to a single anomalous chunk).
 *
 * Budgets are per FRAME and per CANDIDATE, never per painted entry: above a
 * domain's `collisionCapacity` the painted count saturates while candidate
 * work keeps scaling, so a per-painted-entry budget silently relaxes exactly
 * where the cohort gets expensive.
 *
 * Two generic workloads bracket that boundary (`collisionCapacity` is 96):
 *
 *   profile              | entries | candidates | painted | median B/frame | B/candidate | frame budget
 *   ---------------------+---------+------------+---------+----------------+-------------+-------------
 *   generic below cap    |      60 |         60 |      60 |           3182 |        53.0 |       4,100
 *   generic above cap    |     250 |        250 |      96 |          10022 |        40.1 |      13,000
 *
 * The per-source rows (local infrastructure, FIRMS, vessels, tracked, CCTV,
 * rockets, military, cables, radio, detection) drove God's Eye layers removed
 * on 2026-09-26; their calibration history is in git. Wildlife workloads
 * replace them before the world overlay itself goes (bloat grill Q7).
 */
const WORKLOADS = [
  {
    name: 'below collision capacity',
    entries: 60,
    candidates: 60,
    maxBytesPerFrame: 4100,
    saturated: false,
  },
  {
    name: 'above collision capacity',
    entries: 250,
    candidates: 250,
    maxBytesPerFrame: 13_000,
    saturated: true,
  },
];

/** Scale-invariant ceiling shared by every workload. */
const MAX_BYTES_PER_CANDIDATE_PER_FRAME = 154;

const WORKER_PATH = fileURLToPath(new URL('./worldOverlayAllocation.worker.mjs', import.meta.url));

const CALIBRATED_ALLOCATION_RUNTIME = isCalibratedAllocationRuntime();

function runAllocationProbe(entryCount) {
  // Compile hot functions synchronously so the gate measures the calibrated
  // top optimization tier even when the parent unit suite is CPU-saturated.
  // With concurrent recompilation, the fixed frame warmup races TurboFan and
  // this worker nondeterministically measures a lower tier instead.
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', '--no-concurrent-recompilation', WORKER_PATH],
    {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      GEV_ALLOC_ENTRIES: String(entryCount),
    },
    },
  );
  if (result.error) throw new Error(`probe failed to spawn: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`probe exited with ${result.status}: ${String(result.stderr).slice(0, 400)}`);
  }
  const line = String(result.stdout).trim().split('\n').filter(Boolean).at(-1);
  if (!line) throw new Error('probe produced no output');
  let payload;
  try {
    payload = JSON.parse(line);
  } catch (error) {
    throw new Error(`probe output was not JSON: ${error.message}`);
  }
  if (payload.ok !== true) throw new Error(`probe unavailable: ${payload.reason}`);
  return payload;
}

for (const workload of WORKLOADS) {
  test(`steady moving-source frames stay in budget ${workload.name}`, (t) => {
    if (!CALIBRATED_ALLOCATION_RUNTIME) {
      return t.skip(`allocation budgets are calibrated for Node 24; running ${process.versions.node}`);
    }
    const payload = runAllocationProbe(workload.entries);

    // Workload guards: a probe that stopped painting, stopped re-solving, or
    // quietly shrank its cohort would report a flattering number for the wrong
    // reason. Painted count is deliberately NOT pinned to the entry count.
    assert.equal(payload.entryCount, workload.entries);
    assert.equal(payload.candidateCount, workload.candidates, 'bounded cohorts changed unexpectedly');
    assert.equal(payload.profile, 'generic');
    assert.ok(payload.paintedCount > 0, 'probe painted nothing');
    assert.ok(payload.solveCount > 0, 'probe never exercised an arbiter solve');
    assert.ok(payload.measuredFrames >= 400, 'probe measured too few frames');
    if (workload.saturated) {
      assert.ok(
        payload.paintedCount < payload.candidateCount,
        'workload was supposed to exceed the domain collision capacity',
      );
    }

    const report = `${payload.candidateCount} candidates / ${payload.paintedCount} painted`
      + `, median ${payload.medianBytesPerFrame.toFixed(0)} B/frame`
      + ` (max ${payload.maxBytesPerFrame.toFixed(0)})`
      + `, median ${payload.medianBytesPerCandidatePerFrame.toFixed(1)} B/candidate/frame`
      + ` over ${payload.measuredFrames} frames and ${payload.solveCount} solves`
      + `; chunks: ${payload.chunkBytesPerFrame.map((value) => value.toFixed(0)).join(', ')}`;

    assert.ok(
      payload.medianBytesPerFrame <= workload.maxBytesPerFrame,
      `world-overlay steady frame exceeded ${workload.maxBytesPerFrame} B/frame: ${report}`,
    );
    assert.ok(
      payload.medianBytesPerCandidatePerFrame <= MAX_BYTES_PER_CANDIDATE_PER_FRAME,
      `world-overlay steady frame exceeded ${MAX_BYTES_PER_CANDIDATE_PER_FRAME} B/candidate: ${report}`,
    );
  });
}
