import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FAILED_EXIT, NOT_RUN, OUTPUT_TAIL, RETRY_DELAY_SECONDS, failedChecks, firstRuns, plan, record, renderReport, rerunFailed, unresolved, verdict } from '../scripts/qa-sweep.mjs';

const SCRIPTS = path.resolve('scripts');
const files = readdirSync(SCRIPTS);

test('the shards together run every QA script once, except the not-run ones and the sweep itself', () => {
  const runs = [0, 1, 2, 3].map((i) => plan(files, { shard: `${i}/4` }));
  const all = runs.flatMap((r) => r.run);
  const expected = files.filter((f) => /^qa-.*\.mjs$/.test(f)).map((f) => f.replace(/\.mjs$/, ''))
    .filter((n) => n !== 'qa-sweep' && !(n in NOT_RUN));
  assert.equal(all.length, new Set(all).size);
  assert.deepEqual([...all].sort(), expected.sort());
  assert.ok(all.length > 40); // positive control: the sweep is not trivially empty
  // the not-run list is reported once, by shard 0
  assert.deepEqual(runs.map((r) => r.notRun.length > 0), [true, false, false, false]);
});

test('the not-run list is exactly the scripts that need a truth file, a source download or R', () => {
  // either quote style: qa-penguins writes arg("--data", ...) and runs Rscript, and a single-quote-only match let it
  // into the first live sweep, where it crashed twice before opening a browser (2026-11-01)
  const needsLocal = (src) => /arg\(["']--(truth|python|data)["']/.test(src) || /\bRscript\b/.test(src);
  const needs = files.filter((f) => /^qa-.*\.mjs$/.test(f))
    .filter((f) => needsLocal(readFileSync(path.join(SCRIPTS, f), 'utf8')))
    .map((f) => f.replace(/\.mjs$/, ''));
  assert.deepEqual(Object.keys(NOT_RUN).sort(), needs.sort());
  // the match itself: both quote styles and R count; a script that only reads --url does not
  assert.equal(needsLocal(`arg("--data", x)`), true);
  assert.equal(needsLocal(`arg('--truth', x)`), true);
  assert.equal(needsLocal('execFileSync("Rscript", [f])'), true);
  assert.equal(needsLocal(`arg("--url", SITE)`), false);
});

test('--only takes named scripts and refuses a name that is not one', () => {
  assert.deepEqual(plan(files, { only: ['qa-readout'] }).run, ['qa-readout']);
  assert.throws(() => plan(files, { only: ['qa-readuot'] }), /names no QA script: qa-readuot/);
  assert.throws(() => plan(files, { shard: '4/4' }), /bad --shard/);
});

test('a failure is failing twice; failing then passing is flaky', () => {
  assert.equal(verdict(0, undefined), 'pass');
  assert.equal(verdict(1, 0), 'flaky');
  assert.equal(verdict(1, 1), 'fail');
  assert.equal(verdict(124, 2), 'fail'); // a timeout, then a crash
});

// real runs in child processes: one passes, one fails then passes (its state in a file), one fails every time
function childScripts() {
  const once = path.join(mkdtempSync(path.join(tmpdir(), 'qa-sweep-retry-')), 'ran-once');
  const src = {
    'qa-a': 'process.exit(0);',
    'qa-b': `import { existsSync, writeFileSync } from 'node:fs'; if (existsSync(${JSON.stringify(once)})) process.exit(0); writeFileSync(${JSON.stringify(once)}, ''); process.exit(1);`,
    'qa-c': "console.log(JSON.stringify({ check: 'tile', ok: false })); process.exit(1);",
  };
  const events = [];
  const run = (name) => {
    events.push(`run ${name}`);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src[name]], { encoding: 'utf8' });
    return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
  };
  const wait = async (seconds) => events.push(`wait ${seconds}`);
  return { events, run, wait };
}

test("a shard runs each script once and leaves its failures pending: none is rerun on the shard's runner", () => {
  // a runner keeps one IP for the job and some cannot reach PacIOOS at all (probe 2026-11-07: 4 of 20), so a rerun here
  // repeats the failure: in all 6 of qa-mhw's CI failures (11-01 to 11-07) the same-runner rerun failed too
  const { events, run } = childScripts();
  const { results, pending } = firstRuns(['qa-a', 'qa-b', 'qa-c'], run);
  assert.deepEqual(events, ['run qa-a', 'run qa-b', 'run qa-c']);
  assert.deepEqual(results.map((r) => [r.name, r.verdict]), [['qa-a', 'pass']]);
  assert.deepEqual(pending.map((f) => [f.name, f.first.code]), [['qa-b', 1], ['qa-c', 1]]);
  assert.match(pending[1].first.output, /"check":"tile"/); // the first run's evidence travels with it
});

test('the rerun job runs each pending failure once more after one wait; with nothing pending there is no wait', async () => {
  const { events, run, wait } = childScripts();
  const shard0 = { results: [], notRun: ['qa-kelp'], ...firstRuns(['qa-a', 'qa-b'], run) };
  const shard1 = { results: [], notRun: [], ...firstRuns(['qa-c'], run) };
  events.length = 0;
  const done = await rerunFailed([shard0, shard1], run, wait);
  // one wait for the whole sweep however many failed, then each failure once, from every shard
  assert.deepEqual(events, [`wait ${RETRY_DELAY_SECONDS}`, 'run qa-b', 'run qa-c']);
  assert.equal(RETRY_DELAY_SECONDS, 900); // longer than the 11-05 outage seen from home (three 5-min probes)
  assert.deepEqual(done.map((p) => p.results.map((r) => [r.name, r.verdict])), [[['qa-a', 'pass'], ['qa-b', 'flaky']], [['qa-c', 'fail']]]);
  assert.deepEqual(done[1].results[0].checks, ['tile']);
  assert.deepEqual(done.map((p) => [p.notRun, 'pending' in p]), [[['qa-kelp'], false], [[], false]]);
  assert.doesNotThrow(() => unresolved(done));
  // positive control: nothing pending (and a PR's empty shard file, written with no pending key), nothing runs or waits
  events.length = 0;
  const clean = { results: [], notRun: [], ...firstRuns(['qa-a'], run) };
  events.length = 0;
  const same = await rerunFailed([clean, { results: [], notRun: [] }], run, wait);
  assert.deepEqual(events, []);
  assert.deepEqual(same.map((p) => p.results.map((r) => r.verdict)), [['pass'], []]);
});

test('--report refuses a file with a failure still pending, by name; a resolved file is reported', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-sweep-pending-'));
  const first = { code: 1, output: 'TypeError: fetch failed\n' };
  const raw = path.join(dir, 'raw.json');
  writeFileSync(raw, JSON.stringify({ results: [], notRun: [], pending: [{ name: 'qa-mhw', first }] }));
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, 'qa-sweep.mjs'), '--report', raw], { encoding: 'utf8' });
  assert.equal(res.status, 1); // an error, not FAILED_EXIT: the report itself cannot be written
  assert.match(res.stderr, /failed once and not yet rerun: qa-mhw; run --rerun/);
  assert.equal(res.stdout, '');
  // positive control: the same failure with its second run is a verdict, reported and exiting FAILED_EXIT
  const resolved = path.join(dir, 'resolved.json');
  writeFileSync(resolved, JSON.stringify({ results: [record('qa-mhw', first, first)], notRun: [] }));
  const ok = spawnSync(process.execPath, [path.join(SCRIPTS, 'qa-sweep.mjs'), '--report', resolved], { encoding: 'utf8' });
  assert.equal(ok.status, FAILED_EXIT);
  assert.match(ok.stdout, /`qa-mhw`: TypeError: fetch failed/);
});

test('the --rerun CLI resolves shard files into a directory of the same names, and refuses a flag where a file goes', () => {
  // real CLI, nothing pending, so no wait and no script runs: the files pass through with pending gone
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-sweep-rerun-'));
  const shard = path.join(dir, 'qa-sweep-0.json');
  const pass = { name: 'qa-a', verdict: 'pass', codes: [0, null], checks: [] };
  writeFileSync(shard, JSON.stringify({ results: [pass], notRun: ['qa-kelp'], pending: [] }));
  const cli = (...a) => spawnSync(process.execPath, [path.join(SCRIPTS, 'qa-sweep.mjs'), ...a], { encoding: 'utf8', timeout: 20000 });
  const out = path.join(dir, 'final');
  const res = cli('--rerun', out, shard);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'qa-sweep-0.json'), 'utf8')), { results: [pass], notRun: ['qa-kelp'] });
  assert.equal(cli('--report', path.join(out, 'qa-sweep-0.json')).status, 0);
  // a flag after --rerun's directory would be read as a shard file; refused by name, before anything runs or is written
  const late = cli('--rerun', path.join(dir, 'late'), shard, '--url', 'http://example.org/');
  assert.equal(late.status, 1);
  assert.match(late.stderr, /--rerun takes shard \.json files after the directory, not: --url http:\/\/example\.org\//);
  assert.throws(() => readdirSync(path.join(dir, 'late')), /ENOENT/);
  assert.match(cli('--rerun').stderr, /--rerun needs an output directory/);
});

test("a failing or flaky script keeps the end of each run's output in its record; a passing one keeps none", () => {
  // real runs in child processes: a pass, a failed check, a crash
  const run = (src) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
    return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
  };
  const ok = run("console.log(JSON.stringify({ check: 'a', ok: true }));");
  const bad = run("console.log(JSON.stringify({ check: 'tile', ok: false, got: 'blank' })); process.exit(1);");
  const crash = run("await Promise.resolve(); throw new Error('https://example.org/x: HTTP 503');");
  assert.deepEqual([ok.code, bad.code, crash.code], [0, 1, 1]);
  const passed = record('qa-x', ok);
  assert.deepEqual([passed.verdict, passed.outputs], ['pass', undefined]); // a pass keeps nothing
  const failed = record('qa-x', bad, crash);
  assert.deepEqual([failed.verdict, failed.checks, failed.outputs.length], ['fail', ['Error: https://example.org/x: HTTP 503'], 2]);
  assert.match(failed.outputs[0], /"got":"blank"/); // the first run's detail, which the checks list drops
  assert.match(failed.outputs[1], /^Error: https:\/\/example\.org\/x: HTTP 503$/m);
  const flaky = record('qa-x', crash, ok);
  assert.deepEqual([flaky.verdict, flaky.outputs.length], ['flaky', 2]);
  // a failing run with no second run is a caller's mistake, not a verdict: failing twice is what "fail" means. It is
  // refused by name, where it once crashed reading the missing run's output (review of #161); a pass alone, above, is not
  assert.throws(() => record('qa-x', bad), /^Error: qa-x failed \(exit 1\) and was not run again/);
  assert.throws(() => record('qa-x', crash, null), /^Error: qa-x failed \(exit 1\) and was not run again/);
  assert.match(flaky.outputs[0], /HTTP 503/);
  // a long run keeps its last OUTPUT_TAIL characters, where the summary and the error are
  const long = { code: 1, output: `${'x'.repeat(OUTPUT_TAIL)}\nError: last words\n` };
  const kept = record('qa-x', long, long).outputs[0];
  assert.equal(kept.length, OUTPUT_TAIL);
  assert.ok(kept.endsWith('\nError: last words\n'));
  // the issue text stays the checks list: outputs go to the artifact only
  assert.doesNotMatch(renderReport([failed], []), /"got":"blank"/);
});

test('failing checks are named from the JSON lines; a script that crashed is named by its error, not the Node.js line', () => {
  const out = ['{"check":"a","ok":true}', '{"check":"matches-tile","ok":false}', 'Node.js v24'].join('\n');
  assert.deepEqual(failedChecks(out), ['matches-tile']);
  // a real uncaught throw, as qa-haedat's on HAEDAT's 503 (sweep 2026-11-01 reported it as "Node.js v24.14.0")
  const crash = spawnSync(process.execPath, ['--input-type=module', '-e', "await Promise.resolve(); throw new Error('https://example.org/archive.do: HTTP 503');"], { encoding: 'utf8' });
  assert.notEqual(crash.status, 0);
  assert.match(crash.stderr.trim().split('\n').at(-1), /^Node\.js v/); // the case: Node's last line is its version
  assert.deepEqual(failedChecks(`${crash.stdout}${crash.stderr}`), ['Error: https://example.org/archive.do: HTTP 503']);
  // any error class: a TypeError as puppeteer scripts throw, from a real throw too
  const typeErr = spawnSync(process.execPath, ['-e', 'null.x'], { encoding: 'utf8' });
  assert.deepEqual(failedChecks(typeErr.stderr), ["TypeError: Cannot read properties of null (reading 'x')"]);
  // an error with no stack prints in inspect form, "[TypeError: fetch failed] {" with the reason on a "[cause]:" line;
  // qa-mhw crashed that way in the 2026-11-03 sweep and was reported as "Node.js v24.14.0". Real fetches, no network:
  // a server that drops the connection, and one that never answers a fetch with a 200 ms timeout
  const dropped = spawnSync(process.execPath, ['--input-type=module', '-e', "import net from 'node:net'; const s = net.createServer((c) => c.destroy()); await new Promise((r) => s.listen(0, '127.0.0.1', r)); await fetch(`http://127.0.0.1:${s.address().port}/`);"], { encoding: 'utf8', timeout: 20000 });
  assert.match(dropped.stderr, /^\[TypeError: fetch failed\] \{$/m); // the case: no "TypeError: " line to find
  assert.match(failedChecks(dropped.stderr)[0], /^TypeError: fetch failed \(cause: \w*Error: .+\)$/);
  const slow = spawnSync(process.execPath, ['--input-type=module', '-e', "import http from 'node:http'; const s = http.createServer(() => {}); await new Promise((r) => s.listen(0, '127.0.0.1', r)); await fetch(`http://127.0.0.1:${s.address().port}/`, { signal: AbortSignal.timeout(200) });"], { encoding: 'utf8', timeout: 20000 });
  assert.deepEqual(failedChecks(slow.stderr), ['DOMException [TimeoutError]: The operation was aborted due to timeout']);
  // only a whole inspect-form line is a crash: a script's own log line that starts like one is not
  assert.deepEqual(failedChecks('[Error: tile 503] retrying\ntimed out after 900 s\n'), ['timed out after 900 s']);
  // with no error line either, the last line still stands in
  assert.deepEqual(failedChecks('timed out after 900 s\n'), ['timed out after 900 s']);
});

test('the report CLI exits 10 when a script failed twice, and 0 when none did', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-sweep-'));
  const write = (name, results) => {
    const f = path.join(dir, name);
    writeFileSync(f, JSON.stringify({ results, notRun: [] }));
    return f;
  };
  const ok = write('ok.json', [{ name: 'qa-a', verdict: 'pass', codes: [0, null], checks: [] }, { name: 'qa-b', verdict: 'flaky', codes: [1, 0], checks: ['tiles'] }]);
  const bad = write('bad.json', [{ name: 'qa-c', verdict: 'fail', codes: [1, 1], checks: ['matches-tile'] }]);
  const cli = (...f) => spawnSync(process.execPath, [path.join(SCRIPTS, 'qa-sweep.mjs'), '--report', ...f], { encoding: 'utf8' });
  const pass = cli(ok);
  assert.equal(pass.status, 0);
  assert.match(pass.stdout, /1 passed, 1 flaky, 0 failed/);
  const fail = cli(ok, bad);
  assert.equal(fail.status, FAILED_EXIT);
  assert.match(fail.stdout, /Failed twice[\s\S]*`qa-c`: matches-tile/);
  // a shard that crashed wrote no file: with --expect, the missing shard fails the sweep even when the rest passed
  const short = spawnSync(process.execPath, [path.join(SCRIPTS, 'qa-sweep.mjs'), '--report', '--expect', '2', ok], { encoding: 'utf8' });
  assert.equal(short.status, FAILED_EXIT);
  assert.match(short.stdout, /1 shard\(s\) wrote no results/);
  const whole = spawnSync(process.execPath, [path.join(SCRIPTS, 'qa-sweep.mjs'), '--report', '--expect', '2', ok, ok], { encoding: 'utf8' });
  assert.equal(whole.status, 0); // positive control: every shard wrote, nothing failed
  assert.doesNotMatch(whole.stdout, /wrote no results/);
});

test('the report lists the not-run scripts with their reason', () => {
  const text = renderReport([], ['qa-kelp']);
  assert.match(text, /0 passed, 0 flaky, 0 failed, 1 not run/);
  assert.match(text, /`qa-kelp`: truth script needs the kelp source raster/);
});
