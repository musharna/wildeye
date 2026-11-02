#!/usr/bin/env node
/**
 * qa-sweep.mjs — run the browser QA scripts against the live site, one at a time, and report (.github/workflows/qa-sweep.yml).
 * Run:    node scripts/qa-sweep.mjs [--url <site>] [--shard i/n] [--only qa-a,qa-b] [--out results.json]
 * Report: node scripts/qa-sweep.mjs --report [--expect n] results-0.json ... > report.md
 *         (exit 10: a script failed twice, or fewer than n result files: a shard that crashed ran nothing it can report)
 *
 * The 60 scripts ran only by hand until 2026-11-01, when a sweep of all of them found two that had gone stale on a
 * correct site (a hard-coded layer count, a seasonal assumption) and one real stale layer (OBIS absences). A script
 * that fails is run once more: failing twice is a failure, passing the second time is flaky (GIBS and HAEDAT have
 * outages of their own). Scripts that need a truth file built from a large download or CMEMS credentials are listed
 * as not run, never counted as passing.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// need --truth, --python or --data with a downloaded source, or R: run by hand (each script's header says how)
export const NOT_RUN = Object.freeze({
  'qa-cmems-zooc': 'truth file needs CMEMS credentials',
  'qa-soil-bacteria': 'truth file needs the Zenodo ensemble zip',
  'qa-hotspots': 'truth script needs the source shapefile and pyogrio',
  'qa-ifl': 'truth script needs the IFL source files',
  'qa-kelp': 'truth script needs the kelp source raster',
  'qa-penguins': 'truth script needs the mapppdr download and R',
  'qa-seagrass': 'truth script needs the seagrass source raster',
  'qa-tidal-marsh': 'truth script needs the tidal marsh source raster',
});
export const FAILED_EXIT = 10;
const PER_SCRIPT_SECONDS = 900;

/** Which scripts this run takes: every qa-*.mjs but this one and the not-run ones, sorted, then its shard. */
export function plan(files, { shard = '0/1', only = null } = {}) {
  const names = files
    .filter((f) => /^qa-.*\.mjs$/.test(f) && f !== 'qa-sweep.mjs')
    .map((f) => f.replace(/\.mjs$/, ''))
    .sort();
  const [i, n] = shard.split('/').map(Number);
  if (!(Number.isInteger(i) && Number.isInteger(n) && n > 0 && i >= 0 && i < n)) throw new Error(`bad --shard ${shard}`);
  const unknown = only ? only.filter((o) => !names.includes(o)) : [];
  if (unknown.length) throw new Error(`--only names no QA script: ${unknown.join(', ')}`);
  const run = names.filter((name) => !(name in NOT_RUN) && (!only || only.includes(name)));
  return { run: run.filter((_, k) => k % n === i), notRun: i === 0 && !only ? names.filter((name) => name in NOT_RUN) : [] };
}

/** pass, flaky (failed, then passed) or fail (failed twice). */
export function verdict(first, second) {
  if (first === 0) return 'pass';
  return second === 0 ? 'flaky' : 'fail';
}

/** The failing checks a script printed (one JSON line per check, `ok: false`); for a crash, its error; else its last line. */
export function failedChecks(output) {
  const lines = output.split('\n').filter(Boolean);
  const bad = lines.flatMap((l) => {
    try {
      const row = JSON.parse(l);
      return row && row.ok === false ? [row.check ?? l.slice(0, 120)] : [];
    } catch {
      return [];
    }
  });
  if (bad.length) return bad;
  // an uncaught throw ends with the stack and then "Node.js vX"; the "Error: ..." line above the stack says what went wrong
  const thrown = lines.findLast((l) => /^[A-Za-z]*Error( \[[\w-]+\])?: /.test(l));
  return [(thrown ?? lines.at(-1) ?? '').slice(0, 200)].filter(Boolean);
}

export function renderReport(results, notRun, missingShards = 0) {
  const by = (v) => results.filter((r) => r.verdict === v);
  const fail = by('fail');
  const flaky = by('flaky');
  const out = [
    `QA sweep of the live site: ${by('pass').length} passed, ${flaky.length} flaky, ${fail.length} failed, ${notRun.length} not run.`,
    '',
  ];
  const list = (title, rows) => {
    if (!rows.length) return;
    out.push(`**${title}**`, '');
    for (const r of rows) out.push(`- \`${r.name}\`: ${r.checks.join('; ')}`);
    out.push('');
  };
  if (missingShards) out.push(`**${missingShards} shard(s) wrote no results**: the shard itself failed (install, browser, runner), so its scripts are unchecked this week; see the run's log.`, '');
  list('Failed twice', fail);
  list('Flaky (failed, then passed)', flaky);
  if (notRun.length) out.push('**Not run here** (need a downloaded source or credentials; run by hand)', '', ...notRun.map((n) => `- \`${n}\`: ${NOT_RUN[n]}`), '');
  return out.join('\n');
}

function runOne(name, url) {
  const res = spawnSync(process.execPath, [path.join('scripts', `${name}.mjs`), '--url', url], {
    encoding: 'utf8',
    timeout: PER_SCRIPT_SECONDS * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  // a timeout or a signal is a failure, never a pass
  const code = res.status ?? 1;
  return { code, output: `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}` };
}

function main(argv) {
  const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  if (argv.includes('--report')) {
    let files = argv.slice(argv.indexOf('--report') + 1);
    let expect = 0;
    if (files[0] === '--expect') {
      expect = Number(files[1]);
      if (!(Number.isInteger(expect) && expect > 0)) throw new Error(`bad --expect ${files[1]}`);
      files = files.slice(2);
    }
    const parts = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
    const results = parts.flatMap((p) => p.results);
    const notRun = parts.flatMap((p) => p.notRun);
    const missing = Math.max(0, expect - files.length);
    process.stdout.write(`${renderReport(results, notRun, missing)}\n`);
    return missing || results.some((r) => r.verdict === 'fail') ? FAILED_EXIT : 0;
  }
  const url = arg('--url', 'https://musharna.github.io/wildeye/');
  const only = arg('--only', null)?.split(',');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const { run, notRun } = plan(readdirSync(dir), { shard: arg('--shard', '0/1'), only });
  const results = [];
  for (const name of run) {
    const first = runOne(name, url);
    const second = first.code === 0 ? null : runOne(name, url);
    const v = verdict(first.code, second?.code);
    results.push({ name, verdict: v, codes: [first.code, second?.code ?? null], checks: v === 'pass' ? [] : failedChecks((v === 'fail' ? second : first).output) });
    console.error(`${name}: ${v}`);
  }
  writeFileSync(arg('--out', 'qa-sweep.json'), JSON.stringify({ results, notRun }, null, 1));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
