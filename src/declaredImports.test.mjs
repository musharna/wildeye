import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { parseAst } from 'rollup/parseAst';

// Three AST tests and scripts/lint-qa-waits.mjs imported rollup/parseAst, and rollup reached node_modules only because
// Vite 6 depended on it. Vite 8 bundles with Rolldown, rollup left the install, and all four failed with "Cannot find
// package 'rollup'" (2026-09-29). An import is covered when its package is listed in package.json, not when some other
// package happens to install it.

const importedPackages = (src) => {
  const found = new Set();
  const add = (spec) => {
    if (typeof spec !== 'string' || /^[./]/.test(spec) || spec.includes(':') || isBuiltin(spec)) return;
    const parts = spec.split('/');
    found.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  };
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(n.type)
      && n.source?.type === 'Literal') add(n.source.value);
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parent') continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(parseAst(src, { allowReturnOutsideFunction: true }));
  return [...found];
};

const sourceFiles = (dirUrl) => readdirSync(dirUrl, { recursive: true })
  .filter((f) => /\.m?js$/.test(f) && !f.split(/[\\/]/).includes('node_modules'))
  .map((f) => new URL(f, dirUrl));

test('a package import is found in every form; relative, node: and builtin imports are not packages', () => {
  const src = [
    "import { parseAst } from 'rollup/parseAst';",
    "import * as Cesium from 'cesium';",
    "export { x } from '@mapbox/vector-tile';",
    "const m = await import('pbf');",
    "import { readFileSync } from 'node:fs';",
    "import path from 'path';",
    "import { a } from './a.js';",
    "import b from '/abs/b.js';",
    "// import c from 'commented-out';",
    "const s = 'import d from \"in-a-string\"';",
  ].join('\n');
  assert.deepEqual(importedPackages(src).sort(), ['@mapbox/vector-tile', 'cesium', 'pbf', 'rollup']);
});

test('every package that src/, scripts/ and vite.config.js import is declared in package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  const files = [
    ...sourceFiles(new URL('./', import.meta.url)),
    ...sourceFiles(new URL('../scripts/', import.meta.url)),
    new URL('../vite.config.js', import.meta.url),
  ];
  assert.ok(files.length > 100, `found only ${files.length} source files`);
  const root = new URL('../', import.meta.url).pathname;
  const undeclared = files.flatMap((file) => importedPackages(readFileSync(file, 'utf8'))
    .filter((name) => !declared.has(name))
    .map((name) => `${file.pathname.slice(root.length)}: ${name}`));
  assert.deepEqual(undeclared, []);
});
