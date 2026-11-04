import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FAILED_EXIT, NOT_RUN, failedChecks, plan, renderReport, verdict } from '../scripts/qa-sweep.mjs';

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
