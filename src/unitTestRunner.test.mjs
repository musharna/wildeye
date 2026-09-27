import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoverUnitTestFiles } from '../scripts/run-unit-tests.mjs';

test('the unit runner finds every src test file once, in path order, and nothing else', () => {
  const files = discoverUnitTestFiles();
  assert.ok(files.includes('src/unitTestRunner.test.mjs'), 'finds this file');
  assert.ok(files.includes('src/data/tracks.test.mjs'), 'descends into subdirectories');
  assert.deepEqual(files, [...files].sort());
  assert.equal(new Set(files).size, files.length);
  for (const file of files) assert.match(file, /^src\/.+\.test\.mjs$/);
});

test('npm test invokes the unit runner', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-unit-tests.mjs');
  assert.ok(String(pkg.engines?.node || ''), 'engines.node must be declared');
});
