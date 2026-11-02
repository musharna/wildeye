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

test('the not-run list is exactly the scripts that need a truth file or a source download', () => {
  const needs = files.filter((f) => /^qa-.*\.mjs$/.test(f))
    .filter((f) => /arg\('--(truth|python)'/.test(readFileSync(path.join(SCRIPTS, f), 'utf8')))
    .map((f) => f.replace(/\.mjs$/, ''));
  assert.deepEqual(Object.keys(NOT_RUN).sort(), needs.sort());
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
