import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseAst } from 'rollup/parseAst';

// Puppeteer 25 dropped ClickOptions.clickCount (24 had it, deprecated, beside `count`). A script that still passed it got
// ONE click: qa-species' triple-click-to-select stopped selecting, Backspace ate one letter, and the next query typed
// onto the old one ("hum" + "mona" = "hmona"), so suggestion-fade and escape timed out on every build (2026-09-28).
// A script uses the option when an object literal passed to a call has a `clickCount` key.

const passesClickCount = (src) => {
  let hit = false;
  const walk = (n) => {
    if (hit || !n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.arguments.some((a) => a.type === 'ObjectExpression'
      && a.properties.some((p) => p.type === 'Property' && (p.key.name ?? p.key.value) === 'clickCount'))) hit = true;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parent') continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(parseAst(src, { allowReturnOutsideFunction: true }));
  return hit;
};

test('passing clickCount counts; count, a comment or a string does not', () => {
  assert.equal(passesClickCount("await page.click('#q', { clickCount: 3 });"), true);
  assert.equal(passesClickCount("await page.mouse.click(1, 2, { 'clickCount': 2 });"), true);
  assert.equal(passesClickCount("await page.click('#q', { count: 3 });"), false);
  assert.equal(passesClickCount("// was { clickCount: 3 }\nconst why = 'clickCount was removed';"), false);
});

test('no browser script passes the clickCount option Puppeteer 25 removed', () => {
  const dir = new URL('../scripts/', import.meta.url);
  const scripts = readdirSync(dir).filter((f) => f.endsWith('.mjs') && /from 'puppeteer'/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.ok(scripts.length > 10, `found only ${scripts.length} puppeteer scripts`);
  assert.deepEqual(scripts.filter((f) => passesClickCount(readFileSync(new URL(f, dir), 'utf8'))), []);
});
