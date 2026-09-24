import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ShareLinkManager } from './sharelink.js';

// verbatim from sharelink.celestial.test.mjs
function makeManager(hash = '') {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = {
    replaceState(_state, _title, nextHash) {
      window.location.hash = nextHash;
    },
  };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer);
}

test('cmp is written only while a compare provider returns a value', () => {
  const m = makeManager();
  assert.equal(m._buildHashParams().get('cmp'), null);
  let v = 'bm.lc.25';
  m.setCompareParamProvider(() => v);
  assert.equal(m._buildHashParams().get('cmp'), 'bm.lc.25');
  v = null;
  assert.equal(m._buildHashParams().has('cmp'), false);
});

test('parseInitialHash hands back cmp raw; absent is null', () => {
  assert.equal(makeManager('#lat=10&lon=20&cmp=bm.lc.25').parseInitialHash().compare, 'bm.lc.25');
  assert.equal(makeManager('#lat=10&lon=20').parseInitialHash().compare, null);
});

// A source pin like sharelink.celestial.test.mjs's sourceBlock: StyleManager cannot be built under node.
// The behavioural check is qa-compare's reload-restores-compare.
test('StyleManager keeps the initial cmp for main.js to restore after the share restore settles', () => {
  const ui = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  assert.match(ui, /this\._initialCompareParam = this\._initialShareState\?\.compare \?\? null;/);
  assert.match(ui, /get initialCompareParam\(\) \{\s*return this\._initialCompareParam \?\? null;\s*\}/);
});
