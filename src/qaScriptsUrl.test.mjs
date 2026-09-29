import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseAst } from 'rollup/parseAst';

// Every QA script is pointed at a build with `--url`. One read an environment variable instead and ignored the flag, so
// a run meant for a branch preview loaded a default port nothing was serving and timed out before any check (2026-09-28).
// A script reads the flag when the string '--url' is an argument to a call (arg('--url', ...), argv.indexOf('--url')).

const readsUrlFlag = (src) => {
  let hit = false;
  const walk = (n) => {
    if (hit || !n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.arguments.some((a) => a.type === 'Literal' && a.value === '--url')) hit = true;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parent') continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(parseAst(src, { allowReturnOutsideFunction: true }));
  return hit;
};

test('reading the flag counts; a comment or an environment variable does not', () => {
  assert.equal(readsUrlFlag("const url = arg('--url', 'http://x/');"), true);
  assert.equal(readsUrlFlag("const u = argv[argv.indexOf('--url') + 1];"), true);
  assert.equal(readsUrlFlag("// run with --url\nconst u = process.env.QA_BASE_URL || 'http://localhost:4173';"), false);
  assert.equal(readsUrlFlag("const help = 'pass --url';"), false);
});

test('every QA script takes the build to test from --url', () => {
  const dir = new URL('../scripts/', import.meta.url);
  const scripts = readdirSync(dir).filter((f) => /^qa-.*\.mjs$/.test(f));
  assert.ok(scripts.length > 10, `found only ${scripts.length} QA scripts`);
  const missing = scripts.filter((f) => !readsUrlFlag(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(missing, []);
});
