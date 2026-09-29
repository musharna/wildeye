import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseAst } from 'rollup/parseAst';

// A QA wait for "a species suggestion row" was satisfied by the list of a partial query ("monarc", rendered when a keystroke stalled past
// the debounce), and the full query's list replaced the row mid-click: "Node is detached from document" (1 in 8 qa-species runs,
// 2026-09-28; 3/3 when forced). The list now carries data-query, and a wait on its rows must name the query it waits for.
// A wait watches the rows when its predicate's source mentions species-suggestions and button; it keys on the query when it reads dataset.query.

const unkeyedRowWaits = (src) => {
  const found = [];
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'waitForFunction' && n.arguments[0]) {
      const body = src.slice(n.arguments[0].start, n.arguments[0].end);
      if (body.includes('species-suggestions') && body.includes('button') && !body.includes('dataset.query')) found.push(body.slice(0, 90));
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parent') continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(parseAst(src, { allowReturnOutsideFunction: true }));
  return found;
};

test('a wait on suggestion rows counts unless it reads the list query; a wait on the list alone does not count', () => {
  assert.equal(unkeyedRowWaits("await page.waitForFunction(() => document.querySelector('#species-suggestions button')?.textContent.includes('x'));").length, 1);
  assert.equal(unkeyedRowWaits("page.waitForFunction(() => { const l = document.getElementById('species-suggestions'); return l.querySelectorAll('button').length > 0; });").length, 1);
  assert.equal(unkeyedRowWaits("page.waitForFunction((q) => { const l = document.getElementById('species-suggestions'); return l.dataset.query === q && l.querySelector('button'); }, {}, 'm');").length, 0);
  assert.equal(unkeyedRowWaits("page.waitForFunction(() => document.getElementById('species-suggestions').hidden);").length, 0);
});

test('every QA wait on species suggestion rows waits for the list of its own query', () => {
  const dir = new URL('../scripts/', import.meta.url);
  const scripts = readdirSync(dir).filter((f) => /^qa-.*\.mjs$/.test(f));
  assert.ok(scripts.length > 10, `found only ${scripts.length} QA scripts`);
  const unkeyed = scripts.flatMap((f) => unkeyedRowWaits(readFileSync(new URL(f, dir), 'utf8')).map((w) => `${f}: ${w}`));
  assert.deepEqual(unkeyed, []);
  // Positive control: qa-species does wait on the rows, through the keyed helper.
  assert.match(readFileSync(new URL('qa-species.mjs', dir), 'utf8'), /list\.dataset\.query === query/);
});
