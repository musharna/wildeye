// src/reasonableDefaults.test.mjs
//
// What the console looks like the FIRST time it opens — before any share link,
// before any stored state. The "reasonable defaults" batch (owner directive,
// 2026-08-22) moved three of them together:
//
//   1. 3D aircraft models ON, mode `proximity`.
//      Pinned in `data/layerState.test.mjs`, next to the coordinator that
//      actually decides fresh-boot layer state — including the early return that
//      makes each layer's own initializer the operative default.
//   2. Scope feather. Owner: "I like to hide feather" set it to 0% on
//      2026-08-22; the owner revised that to 8% on 2026-08-23 and locked 11%
//      on 2026-08-24, a soft
//      edge. The hard crop is still one drag away, and that is pinned too.
//   3-4. Detection ON by default and its OUTSIDE opacity — removed with the
//      God's Eye detection overlay (2026-09-26).
//
// Each pin below has the same three parts, because a default is never one
// literal:
//
//   • the first-run VALUE, at every surface that independently decides it — a
//     fresh boot runs no restore, so these literals ARE the startup state and
//     changing one alone ships a UI that disagrees with its own engine;
//   • explicit state still WINS over it — a link, or the operator's own hand,
//     because "default" means "what you get when you said nothing";
//   • the surrounding override machinery is INTACT, so a default flip cannot
//     quietly take a separate landed behaviour with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { KEYHOLE_OUTER_RADIUS } from './celestialRing.js';
import {
  SCOPE_FEATHER_RATIO_DEFAULT,
  getScopeMaskFeather,
  scopeMaskGeometry,
  setScopeMaskFeather,
} from './scopeMask.js';
import { ShareLinkManager } from './sharelink.js';

const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const shareSource = fs.readFileSync(new URL('./sharelink.js', import.meta.url), 'utf8');

/** A ShareLinkManager over a synthetic hash — enough surface for parseInitialHash. */
function managerForHash(hash) {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = { replaceState(_s, _t, next) { window.location.hash = next; } };
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

// ---------------------------------------------------------------------------
// 2. Scope feather — a subtle soft edge on a first run
// ---------------------------------------------------------------------------

test('first run opens with a subtle scope feather, at every surface that decides it', () => {
  assert.equal(SCOPE_FEATHER_RATIO_DEFAULT, 0.11,
    'owner final lock 2026-08-24, superseding the 08-22 hard-crop and 08-23 8% rulings');
  assert.equal(getScopeMaskFeather(), 0.11,
    'and the live module starts there, not merely documents it');

  // The slider and its readout are the same default rendered as markup — a
  // fresh boot applies no restore, so a stale value here would show one number
  // over a mask drawn at another.
  assert.match(indexHtml, /id="scope-feather-slider"[^>]*\svalue="11"/,
    'index.html: the feather slider ships at 11');
  assert.match(indexHtml, /id="scope-feather-value"[^>]*>11%</,
    'index.html: and its readout agrees with the handle');

  // The link this session generates must describe the mask this session draws,
  // for the window before the first _syncShareState.
  assert.match(shareSource, /this\._scopeFeatherPct = 11;/,
    'sharelink.js: the generator starts from the same value the mask starts at');
});

test('an explicit feather still wins over the subtle default', () => {
  // A link is authored state. The new default governs a session that said
  // nothing; it must never overwrite one that said something.
  assert.equal(managerForHash('#lat=10&lon=20&scf=35').parseInitialHash().scopeFeatherPct, 35);
  assert.equal(managerForHash('#lat=10&lon=20&scf=64').parseInitialHash().scopeFeatherPct, 64);
  assert.equal(managerForHash('#lat=10&lon=20&scf=0').parseInitialHash().scopeFeatherPct, 0,
    'an explicit 0 is a choice too, not an absent field');

  // A link from before `scf` existed still restores what ITS author saw, which
  // is the retired 35 — parsing an archive is not the same question as booting
  // fresh, and this deliberately did NOT move with either later default.
  assert.equal(managerForHash('#lat=10&lon=20&style=normal').parseInitialHash().scopeFeatherPct, 35,
    'a pre-scf link restores the author\'s view, not the new default');
});

test('the subtle default did not weaken the feather control, and 0 is still reachable', () => {
  // The cheap way to move a default would be to nerf the control. Prove the
  // slider still spans its full range and the geometry is still DERIVED from
  // the ratio — a check that would pass vacuously if it only ever saw one value.
  assert.match(indexHtml, /id="scope-feather-slider"[^>]*\smin="0"[^>]*\smax="100"/,
    'the slider still offers the whole range');
  const previous = getScopeMaskFeather();
  try {
    for (const ratio of [0.35, 0.7, 1]) {
      setScopeMaskFeather(ratio);
      const geo = scopeMaskGeometry(1200, 900);
      const keyholeR = 900 * 0.5 * KEYHOLE_OUTER_RADIUS;
      assert.ok(Math.abs((geo.outerR - geo.innerR) - keyholeR * ratio) < 1e-9,
        `feather ${ratio} must still widen the band to that fraction of the keyhole`);
    }
    // The new default is a real, narrow band — not the hard crop, and nowhere
    // near the retired 35 % halo.
    setScopeMaskFeather(SCOPE_FEATHER_RATIO_DEFAULT);
    const soft = scopeMaskGeometry(1200, 900);
    const keyholeR = 900 * 0.5 * KEYHOLE_OUTER_RADIUS;
    assert.ok(Math.abs((soft.outerR - soft.innerR) - keyholeR * SCOPE_FEATHER_RATIO_DEFAULT) < 1e-9,
      'the default really draws its own band, derived from the ratio');
    assert.ok(soft.outerR > soft.innerR, 'and it is a band, not a hard edge');
    // The hard crop the previous default shipped is still one drag away.
    setScopeMaskFeather(0);
    const hard = scopeMaskGeometry(1200, 900);
    assert.equal(hard.outerR, hard.innerR,
      'an explicit 0 is still the hard crop — the path was not removed with the default');
  } finally {
    setScopeMaskFeather(previous);
  }
});
