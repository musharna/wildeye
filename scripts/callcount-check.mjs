#!/usr/bin/env node
/**
 * callcount-check — deterministic call-count ratchet for the wildlife layers'
 * time steps and particle frames.
 *
 * Timings and allocated bytes depend on host load and on which JIT/IC regime V8
 * lands in, so a budget on either carries headroom, and a regression smaller
 * than that headroom is invisible. This gate counts WORK instead. It runs
 * deterministic workers (fixed-seed fixtures, a frozen wall clock, a virtual
 * performance clock, a seeded Math.random, a stub viewer) under
 * `NODE_V8_COVERAGE`, which records the exact invocation count of every
 * function, and sums the counts for `src/` functions.
 *
 * A count is not a timing: it is identical across runs, across host load, and
 * across Node 18/24 (measured 2026-09-24 on a since-removed overlay workload,
 * and again 2026-09-26 on the wildlife ones). So the budget is the baseline itself,
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
const WILDLIFE_WORKER = path.join(ROOT, 'scripts/callcount-wildlife.worker.mjs');
export const BASELINE_PATH = path.join(ROOT, 'scripts/callcount-baseline.json');

/**
 * Each workload names its worker, the env that selects its scene, and `expect`:
 * fields asserted against the worker's own report, so the echoed profile name
 * alone never has to prove the intended scene ran. The world-overlay workloads
 * went with the overlay on 2026-09-26 (bloat grill Q7).
 */
export const WORKLOADS = Object.freeze([
  { name: 'tracks-step', worker: WILDLIFE_WORKER, env: { GEV_WILDLIFE_PROFILE: 'tracks-step' }, expect: { features: 121, steps: 104 } },
  { name: 'occurrences-step', worker: WILDLIFE_WORKER, env: { GEV_WILDLIFE_PROFILE: 'occurrences-step' }, expect: { features: 161, steps: 30 } },
  { name: 'birds-tick', worker: WILDLIFE_WORKER, env: { GEV_WILDLIFE_PROFILE: 'birds-tick' }, expect: { particles: 1500, frames: 121 } },
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
    const result = spawnSync(process.execPath, [workload.worker], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, ...workload.env, NODE_V8_COVERAGE: coverageDir },
    });
    if (result.error) throw new Error(`${workload.name}: worker failed to spawn: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`${workload.name}: worker exited ${result.status}: ${String(result.stderr).slice(0, 800)}`);
    }
    const report = JSON.parse(result.stdout.trim().split('\n').pop());
    if (!report.ok) throw new Error(`${workload.name}: worker reported ${JSON.stringify(report)}`);
    for (const [key, value] of Object.entries(workload.expect)) {
      if (report[key] !== value) {
        throw new Error(`${workload.name}: expected ${key} ${value}, worker reported ${JSON.stringify(report[key])} `
          + `(env ${JSON.stringify(workload.env)} not recognised?)`);
      }
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
