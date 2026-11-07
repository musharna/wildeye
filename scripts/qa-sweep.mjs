#!/usr/bin/env node
/**
 * qa-sweep.mjs — run the browser QA scripts against the live site, one at a time, and report (.github/workflows/qa-sweep.yml).
 * Run:    node scripts/qa-sweep.mjs [--url <site>] [--shard i/n] [--only qa-a,qa-b] [--out results.json]
 *         (each script once: a failure is left pending in results.json)
 * Rerun:  node scripts/qa-sweep.mjs [--url <site>] --rerun <out-dir> results-0.json ...
 *         (on another runner: each pending failure once more, after a 15-minute wait; writes <out-dir>/<same names>)
 * Report: node scripts/qa-sweep.mjs --report [--expect n] results-0.json ... > report.md
 *         (exit 10: a script failed twice, or fewer than n result files: a shard that crashed ran nothing it can report;
 *         a file with a failure still pending is refused, since it has no verdict yet)
 *
 * The 60 scripts ran only by hand until 2026-11-01, when a sweep of all of them found two that had gone stale on a
 * correct site (a hard-coded layer count, a seasonal assumption) and one real stale layer (OBIS absences). A script
 * that fails is run once more by a later job on a runner of its own, after a 15-minute wait: failing twice is a
 * failure, passing the second time is flaky (GIBS, HAEDAT and PacIOOS have outages of their own, and some runners
 * cannot reach PacIOOS at all). Scripts that need a truth file built from a large download or CMEMS credentials are
 * listed as not run, never counted as passing.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// a failing run keeps the end of its output, where the summary line and a crash's error are
export const OUTPUT_TAIL = 64 * 1024;

/**
 * What the sweep keeps of one script's runs (first, and second when the first failed: { code, output }): its verdict,
 * exit codes and failing checks, and for anything but a pass the end of each run's output, so a failure seen only in
 * CI can be read from the artifact (2026-11-04: qa-readout, qa-species and qa-gibs failed in CI and no host could rerun
 * them cleanly). `second` may be left out only when `first` passed: a failing `first` with no `second` throws, since
 * "fail" means failing twice and a failing run alone has no verdict yet. A run may carry `checks` already read from
 * its whole output (a shard's pending failure keeps only the tail); they are used in place of reading its output.
 */
export function record(name, first, second = null) {
  if (first.code !== 0 && !second) throw new Error(`${name} failed (exit ${first.code}) and was not run again: record() needs the second run`);
  const v = verdict(first.code, second?.code);
  const named = v === 'fail' ? second : first;
  const r = { name, verdict: v, codes: [first.code, second?.code ?? null], checks: v === 'pass' ? [] : (named.checks ?? failedChecks(named.output)) };
  if (v !== 'pass') r.outputs = [first, second].filter(Boolean).map((run) => run.output.slice(-OUTPUT_TAIL));
  return r;
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
  // an uncaught throw ends with "Node.js vX". Above it, an error with a stack prints "Name: message"; one without
  // (undici's "fetch failed", an aborted fetch) prints in inspect form, "[Name: message]" or "[Name: message] {",
  // with the reason on an indented "[cause]: ..." line below
  const plain = (l) => (/^[A-Za-z]*Error( \[[\w-]+\])?: /.test(l) ? l : null);
  const inspected = (l) => l.match(/^\[([A-Za-z]*(?:Error|Exception)(?: \[[\w-]+\])?: [^\n]*)\](?: \{)?$/)?.[1] ?? null;
  const at = lines.findLastIndex((l) => plain(l) ?? inspected(l));
  if (at < 0) return [(lines.at(-1) ?? '').slice(0, 200)].filter(Boolean);
  const cause = lines.slice(at + 1).find((l) => /^\s+\[cause\]: /.test(l));
  const thrown = plain(lines[at]) ?? inspected(lines[at]);
  return [(cause ? `${thrown} (cause: ${cause.replace(/^\s+\[cause\]: /, '')})` : thrown).slice(0, 200)];
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
  if (missingShards) out.push(`**${missingShards} shard(s) wrote no results**: the shard or the rerun job failed (install, browser, runner), so its scripts are unchecked this week; see the run's log.`, '');
  list('Failed twice', fail);
  list('Flaky (failed, then passed)', flaky);
  if (notRun.length) out.push('**Not run here** (need a downloaded source or credentials; run by hand)', '', ...notRun.map((n) => `- \`${n}\`: ${NOT_RUN[n]}`), '');
  return out.join('\n');
}

// A failed script is rerun on another runner and after this wait, never on its shard's runner at once. The wait: a retry
// seconds later lands in the same outage, and PacIOOS refused or stalled connections from home for about 15 minutes on
// 2026-11-05 (2:33-2:44 PM EST, three 5-minute probes in a row). The other runner: a GitHub runner keeps one IP for the
// job, and some IPs cannot reach PacIOOS at all. In a probe on 2026-11-07, 4 of 20 runners failed all 20 tries over
// 5 minutes, to its name and its bare IP, while reaching NOAA's ERDDAP every time; the other 16 never failed. In every
// one of qa-mhw's 6 failures in 16 sweeps (11-01 to 11-07) the rerun on the same runner failed too, after the wait as
// well as without it. One wait per call however many failed, so a bad day costs this once per shard's rerun lane (they
// run in parallel), not per script.
export const RETRY_DELAY_SECONDS = 900;

/**
 * A shard's runs: each named script once (run(name) → { code, output }). A pass is recorded; a failure is left pending,
 * with the end of its output, for rerunFailed() on another runner. Returns { results, pending: [{ name, first }] }.
 */
export function firstRuns(names, run, log = () => {}) {
  const results = [];
  const pending = [];
  for (const name of names) {
    const first = run(name);
    log(`${name}: ${first.code === 0 ? 'pass' : `failed (exit ${first.code}), rerun on another runner`}`);
    if (first.code === 0) results.push(record(name, first));
    // the checks are read from the whole output here, where it still is: a failing check printed before the kept tail
    // would otherwise be lost from a flaky verdict, which names the first run's checks (review of #164)
    else pending.push({ name, first: { code: first.code, output: first.output.slice(-OUTPUT_TAIL), checks: failedChecks(first.output) } });
  }
  return { results, pending };
}

/**
 * A rerun lane (one per shard, so a bad day's reruns keep the shards' parallel budget): given shard files ({ results, notRun, pending }), if any failure is pending, wait(RETRY_DELAY_SECONDS)
 * once, then run each pending script once more and record both runs. Returns the files with pending resolved into
 * results, in the same order; a file with nothing pending comes back unchanged.
 */
export async function rerunFailed(parts, run, wait, log = () => {}) {
  const names = parts.flatMap((p) => (p.pending ?? []).map((f) => f.name));
  if (names.length) {
    log(`${names.length} failed on their shard; rerunning here after ${RETRY_DELAY_SECONDS} s: ${names.join(', ')}`);
    await wait(RETRY_DELAY_SECONDS);
  }
  return parts.map(({ pending = [], ...part }) => ({
    ...part,
    results: [
      ...part.results,
      ...pending.map(({ name, first }) => {
        const r = record(name, first, run(name));
        log(`${name}: ${r.verdict}`);
        return r;
      }),
    ],
  }));
}

/** --report's input: a file with a failure still pending has no verdict for it, so it is refused by name. */
export function unresolved(parts) {
  const names = parts.flatMap((p) => (p.pending ?? []).map((f) => f.name));
  if (names.length) throw new Error(`failed once and not yet rerun: ${names.join(', ')}; run --rerun on these files first`);
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

async function main(argv) {
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
    unresolved(parts);
    const results = parts.flatMap((p) => p.results);
    const notRun = parts.flatMap((p) => p.notRun);
    const missing = Math.max(0, expect - files.length);
    process.stdout.write(`${renderReport(results, notRun, missing)}\n`);
    return missing || results.some((r) => r.verdict === 'fail') ? FAILED_EXIT : 0;
  }
  const url = arg('--url', 'https://musharna.github.io/wildeye/');
  const log = (line) => console.error(line);
  if (argv.includes('--rerun')) {
    const outDir = argv[argv.indexOf('--rerun') + 1];
    const files = argv.slice(argv.indexOf('--rerun') + 2);
    // every argument after the directory is a shard's file: a flag there (--url last) would be read as one
    if (!outDir || outDir.startsWith('--')) throw new Error('--rerun needs an output directory');
    const bad = files.filter((f) => !f.endsWith('.json'));
    if (bad.length) throw new Error(`--rerun takes shard .json files after the directory, not: ${bad.join(' ')}`);
    const parts = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
    const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const done = await rerunFailed(parts, (name) => runOne(name, url), wait, log);
    mkdirSync(outDir, { recursive: true });
    done.forEach((part, k) => writeFileSync(path.join(outDir, path.basename(files[k])), JSON.stringify(part, null, 1)));
    return 0;
  }
  const only = arg('--only', null)?.split(',');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const { run, notRun } = plan(readdirSync(dir), { shard: arg('--shard', '0/1'), only });
  const { results, pending } = firstRuns(run, (name) => runOne(name, url), log);
  writeFileSync(arg('--out', 'qa-sweep.json'), JSON.stringify({ results, notRun, pending }, null, 1));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(await main(process.argv.slice(2)));
