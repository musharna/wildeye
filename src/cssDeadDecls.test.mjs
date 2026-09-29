import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findDeadDeclarations } from '../scripts/css-dead-decls.mjs';

// style.css grew one rule per fix, each placed after the last: the minimal HUD's bottom-left corner had `bottom` set
// five times and four could never apply, and a dock transform was overridden 350 lines later (2026-09-28).

const found = (css) => findDeadDeclarations(css).map((d) => `${d.line}:${d.prop}`);

test('a later identical selector kills the earlier declaration; a live one next to it is not flagged', () => {
  assert.deepEqual(found('.a { bottom: 1px; color: red; }\n.b { bottom: 3px; }\n.a { bottom: 2px; }'), ['1:bottom']);
});

test('a later rule under a narrower condition does not kill an unconditional one; a broader later one does', () => {
  assert.deepEqual(found('.a { bottom: 1px; }\n@media (max-width: 720px) { .a { bottom: 2px; } }'), []);
  assert.deepEqual(found('@media (max-width: 720px) { .a { bottom: 1px; } }\n.a { bottom: 2px; }'), ['1:bottom']);
  assert.deepEqual(found('@media (max-width: 720px) { .a { bottom: 1px; } }\n@media (max-width: 900px) { .a { bottom: 2px; } }'), []);
  assert.deepEqual(found('@media (max-width: 720px) { .a { bottom: 1px; } }\n@media (max-width:  720px) { .a { bottom: 2px; } }'), ['1:bottom']);
});

test('an earlier !important survives a later normal declaration; a later !important kills it', () => {
  assert.deepEqual(found('.a { bottom: 1px !important; }\n.a { bottom: 2px; }'), []);
  assert.deepEqual(found('.a { bottom: 1px !important; }\n.a { bottom: 2px !important; }'), ['1:bottom']);
});

test('a selector list is dead only when every selector in it is overridden', () => {
  assert.deepEqual(found('.a, .b { bottom: 1px; }\n.a { bottom: 2px; }'), []);
  assert.deepEqual(found('.a, .b { bottom: 1px; }\n.b, .a { bottom: 2px; }'), ['1:bottom']);
});

test('a later rule a browser may drop whole (a newer pseudo in its list) is not a killer, unless the earlier uses it too', () => {
  assert.deepEqual(found('.a { transform: none; }\n.a, .a:has(.b) { transform: scale(2); }'), []);
  assert.deepEqual(found('.a:has(.b) { transform: none; }\n.a, .a:has(.b) { transform: scale(2); }'), ['1:transform']);
  assert.deepEqual(found('.a { color: red; }\n.a, .a:hover { color: blue; }'), ['1:color']);
});

test('fallback repeats in one rule, shorthand/longhand pairs and keyframe steps are never flagged; @layer is refused', () => {
  assert.deepEqual(found('.a { width: 10px; width: calc(1px + 1vw); }'), []);
  assert.deepEqual(found('.a { bottom: 1px; }\n.a { inset: 0; }'), []);
  assert.deepEqual(found('@keyframes k { from { opacity: 0; } from { opacity: 1; } }'), []);
  assert.throws(() => findDeadDeclarations('@layer x { .a { bottom: 1px; } }'), /@layer/);
});

test('style.css has no declaration that can never apply', () => {
  const dead = findDeadDeclarations(readFileSync(new URL('../style.css', import.meta.url), 'utf8'));
  assert.deepEqual(dead.map((d) => `style.css:${d.line} ${d.selector} { ${d.prop} } overridden at ${d.killedBy}`), []);
});
