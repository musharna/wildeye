import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAst } from 'rollup/parseAst';
import { discoverUnitTestFiles } from '../scripts/run-unit-tests.mjs';

// src/data/modelMatrix.test.mjs tested the aircraft layers' per-model matrices, which went with the God's Eye layers in
// 54192b3; it imported only cesium, so it kept passing for months as a test of Cesium's own Transforms (2026-09-29).
// A test file reaches this repo when it imports a relative module or uses import.meta (to locate a repo file it reads).

const reachesRepo = (src) => {
  let hit = false;
  const walk = (n) => {
    if (hit || !n || typeof n.type !== 'string') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(n.type)
      && typeof n.source?.value === 'string' && /^\.\.?\//.test(n.source.value)) hit = true;
    if (n.type === 'MetaProperty' && n.meta.name === 'import') hit = true;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parent') continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(parseAst(src, { allowReturnOutsideFunction: true }));
  return hit;
};

test('a relative import or import.meta reaches the repo; package, builtin, comment and string mentions do not', () => {
  assert.equal(reachesRepo("import { a } from './a.js';"), true);
  assert.equal(reachesRepo("import b from '../scripts/b.mjs';"), true);
  assert.equal(reachesRepo("const c = await import('./c.js');"), true);
  assert.equal(reachesRepo("const u = new URL('../vite.config.js', import.meta.url);"), true);
  assert.equal(reachesRepo([
    "import { Transforms } from 'cesium';",
    "import { readFileSync } from 'node:fs';",
    "// import { a } from './a.js';",
    "const s = \"import b from '../b.js'\";",
  ].join('\n')), false);
});

test('every unit test file reaches code in this repo', () => {
  const files = discoverUnitTestFiles();
  assert.ok(files.length > 50, `found only ${files.length} test files`);
  const detached = files.filter((file) => !reachesRepo(readFileSync(file, 'utf8')));
  assert.deepEqual(detached, []);
});
