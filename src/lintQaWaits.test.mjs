import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { findSleepThenInteract } from '../scripts/lint-qa-waits.mjs';

// Three QA misses on 2026-09-27 were each a fixed sleep standing in for "ready" before an interaction, lost on a busy
// page to a transition or a pending timer (LESSONS.md). The lint flags that shape; a state wait is not flagged.

const lines = (src) => findSleepThenInteract(src).map((h) => h.line);

test('a fixed sleep then a click, focus, hover or tap is flagged, in every sleep spelling', () => {
  assert.deepEqual(lines('await sleep(240);\nawait page.click("#a");'), [1]);
  assert.deepEqual(lines('await new Promise((r) => setTimeout(r, 500));\nawait page.focus("#a");'), [1]);
  assert.deepEqual(lines('await page.waitForTimeout(300);\nawait page.hover("#a");'), [1]);
  assert.deepEqual(lines('async function f() {\n  await delay(9);\n  await page.evaluate(() => document.querySelector("#a").click());\n}'), [2]);
  assert.deepEqual(lines('await sleep(1);\nawait page.touchscreen.tap(1, 2);'), [1]);
});

test('a state wait, a measurement, or a sleep and a click in different functions are not flagged', () => {
  assert.deepEqual(lines('await page.waitForFunction(() => ready());\nawait page.click("#a");'), []);
  assert.deepEqual(lines('await sleep(500);\nconst r = await page.evaluate(() => measure());'), []);
  assert.deepEqual(lines('await sleep(500);\nawait page.waitForFunction(() => ready());\nawait page.click("#a");'), []);
  assert.deepEqual(lines('const a = async () => { await sleep(9); };\nconst b = async () => { await page.click("#a"); };'), []);
});

test('a sleep is allowed with a reason on its line; a bare marker is not a reason', () => {
  assert.deepEqual(lines('await sleep(500); // qa-wait-ok: let the 420 ms mouse-away close fire first\nawait page.click("#a");'), []);
  assert.deepEqual(lines('await sleep(500); // qa-wait-ok:\nawait page.click("#a");'), [1]);
});

test('no script in scripts/ sleeps a fixed time and then interacts', () => {
  const dir = new URL('../scripts/', import.meta.url);
  const found = readdirSync(dir).filter((f) => f.endsWith('.mjs'))
    .flatMap((f) => findSleepThenInteract(readFileSync(new URL(f, dir), 'utf8')).map((h) => `scripts/${f}:${h.line}`));
  assert.deepEqual(found, []);
});
