#!/usr/bin/env node
/**
 * callcount-check — deterministic call-count ratchet for the world-overlay frame.
 *
 * The allocation gates (`worldOverlayAllocation.test.mjs`) measure bytes, and
 * bytes depend on which JIT/IC regime V8 lands in: the same workload shows two
 * stable modes, so every budget carries headroom for the slower one, and a
 * regression smaller than that headroom is invisible. This gate counts WORK
 * instead. It runs the same deterministic worker (fixed-seed workload, virtual
 * clock, Canvas2D stub) under `NODE_V8_COVERAGE`, which records the exact
 * invocation count of every function, and sums the counts for `src/` functions.
 *
 * A count is not a timing: it is identical across runs, across host load, and
 * across Node 18/24 (measured 2026-09-24: 9,881,963 calls for all-live-radio on
 * both, zero per-function differences). So the budget is the baseline itself,
 * with no headroom, and it only moves one way:
 *
 *   total > baseline  → FAIL (regression; per-function deltas printed)
 *   total < baseline  → FAIL (improvement not locked in; rerun with --update)
 *   total = baseline  → pass
 *
 * `--update` rewrites the baseline for workloads that got cheaper. Raising a
 * baseline needs `--update --allow-increase`, so an accepted cost is a
 * deliberate, reviewable diff to `scripts/callcount-baseline.json`.
 *
 * Counts are keyed `file:functionName` (anonymous functions pooled per file) so
 * edits that shift byte offsets do not churn the per-function table; only the
 * per-workload totals are gated. The per-function table is diagnostics.
 *
 * Usage: node scripts/callcount-check.mjs [--update [--allow-increase]] [--json]
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKER_PATH = path.join(ROOT, 'src/overlays/worldOverlayAllocation.worker.mjs');
export const BASELINE_PATH = path.join(ROOT, 'scripts/callcount-baseline.json');

/**
 * Frame shape shared by every workload: 1 warmup + 1 stabilization chunk + 1
 * measured chunk of 60 frames = 121 frames. The worker's `|| default` parsing
 * cannot express zero, so 1 is the floor for warmup and stabilization.
 */
const FRAME_ENV = Object.freeze({
  GEV_ALLOC_WARMUP: '1',
  GEV_ALLOC_STABILIZATION_CHUNKS: '1',
  GEV_ALLOC_CHUNK: '60',
  GEV_ALLOC_CHUNKS: '1',
});

/**
 * `candidates` is asserted against the worker's own report: the worker falls
 * back to the generic workload for an unknown profile name and still echoes
 * that name, so the echo alone cannot prove the intended scene ran.
 */
export const WORKLOADS = Object.freeze([
  { name: 'generic-above-cap', profile: 'generic', entries: 250, candidates: 250 },
  { name: 'all-live-radio', profile: 'all-live-radio', entries: 864, candidates: 864 },
  { name: 'phase6-detection', profile: 'phase6-detection', entries: 5000, candidates: 5000 },
]);

/** Sum V8 precise-coverage call counts per `src/` file:function. */
export function aggregateCoverage(scriptCoverages) {
  const counts = {};
  for (const script of scriptCoverages) {
    if (script.url.includes('/node_modules/')) continue;
    const match = script.url.match(/\/(src\/[^?#]*)$/);
    if (!match) continue;
    for (const fn of script.functions) {
      const count = fn.ranges[0].count;
      if (!count) continue;
      const key = `${match[1]}:${fn.functionName || '(anonymous)'}`;
      counts[key] = (counts[key] || 0) + count;
    }
  }
  return counts;
}

export function totalCalls(counts) {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

/** Run one workload in a coverage-instrumented child and return its counts. */
export function measureWorkload(workload) {
  const coverageDir = mkdtempSync(path.join(tmpdir(), 'gev-callcount-'));
  try {
    const result = spawnSync(process.execPath, ['--expose-gc', WORKER_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      env: {
        ...process.env,
        ...FRAME_ENV,
        GEV_ALLOC_PROFILE: workload.profile,
        GEV_ALLOC_ENTRIES: String(workload.entries),
        NODE_V8_COVERAGE: coverageDir,
      },
    });
    if (result.error) throw new Error(`${workload.name}: worker failed to spawn: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`${workload.name}: worker exited ${result.status}: ${String(result.stderr).slice(0, 800)}`);
    }
    const report = JSON.parse(result.stdout.trim().split('\n').pop());
    if (!report.ok) throw new Error(`${workload.name}: worker reported ${JSON.stringify(report)}`);
    if (report.candidateCount !== workload.candidates) {
      throw new Error(`${workload.name}: expected ${workload.candidates} candidates, worker ran ${report.candidateCount} `
        + `(profile ${JSON.stringify(workload.profile)} not recognised?)`);
    }
    const scripts = readdirSync(coverageDir)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => JSON.parse(readFileSync(path.join(coverageDir, file), 'utf8')).result);
    const counts = aggregateCoverage(scripts);
    if (totalCalls(counts) === 0) {
      throw new Error(`${workload.name}: coverage recorded no src/ calls under ${coverageDir}`);
    }
    return counts;
  } finally {
    rmSync(coverageDir, { recursive: true, force: true });
  }
}

/** Largest per-function changes, for the failure message. */
export function topDeltas(baselineCounts, currentCounts, limit = 12) {
  const keys = new Set([...Object.keys(baselineCounts), ...Object.keys(currentCounts)]);
  return [...keys]
    .map((key) => ({ key, delta: (currentCounts[key] || 0) - (baselineCounts[key] || 0) }))
    .filter((row) => row.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}

/**
 * Compare measured totals to the baseline. Pure, so the ratchet's verdicts
 * are unit-testable without spawning workers.
 */
export function compareToBaseline(baseline, measured) {
  return Object.entries(measured).map(([name, counts]) => {
    const current = totalCalls(counts);
    const recorded = baseline.workloads?.[name];
    if (!recorded) return { name, verdict: 'missing', current, baseline: null, deltas: [] };
    const verdict = current > recorded.total ? 'regressed' : current < recorded.total ? 'improved' : 'equal';
    return {
      name,
      verdict,
      current,
      baseline: recorded.total,
      deltas: verdict === 'equal' ? [] : topDeltas(recorded.functions, counts),
    };
  });
}

function formatRow(row) {
  const change = row.baseline === null ? '' : ` (${row.current - row.baseline >= 0 ? '+' : ''}${row.current - row.baseline}, `
    + `${(((row.current - row.baseline) / row.baseline) * 100).toFixed(2)}%)`;
  const lines = [`${row.verdict.toUpperCase().padEnd(9)} ${row.name}: ${row.current} calls, baseline ${row.baseline ?? 'none'}${change}`];
  for (const { key, delta } of row.deltas) lines.push(`            ${delta > 0 ? '+' : ''}${delta}  ${key}`);
  return lines.join('\n');
}

function main(argv) {
  const update = argv.includes('--update');
  const allowIncrease = argv.includes('--allow-increase');
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const measured = Object.fromEntries(WORKLOADS.map((workload) => [workload.name, measureWorkload(workload)]));
  const rows = compareToBaseline(baseline, measured);

  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(rows)}\n`);
  else for (const row of rows) console.log(formatRow(row));

  if (update) {
    const blocked = rows.filter((row) => (row.verdict === 'regressed' || row.verdict === 'missing') && !allowIncrease);
    if (blocked.length) {
      console.error(`refusing to raise the baseline for ${blocked.map((row) => row.name).join(', ')}; `
        + 'pass --allow-increase if the extra work is intended');
      return 1;
    }
    const next = { note: baseline.note, workloads: {} };
    for (const workload of WORKLOADS) {
      const counts = measured[workload.name];
      next.workloads[workload.name] = {
        total: totalCalls(counts),
        functions: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
      };
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wrote ${path.relative(ROOT, BASELINE_PATH)}`);
    return 0;
  }

  const failing = rows.filter((row) => row.verdict !== 'equal');
  if (failing.some((row) => row.verdict === 'improved')) {
    console.error('call count dropped: lock the gain in with `npm run perf:callcount -- --update` and commit the baseline');
  }
  if (failing.some((row) => row.verdict === 'regressed' || row.verdict === 'missing')) {
    console.error('call count rose: find the added work above, or accept it with `--update --allow-increase`');
  }
  return failing.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
