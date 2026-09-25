// The HUD speaks plainly (wave item 6, 2026-09-25): the upstream fork dressed the globe as a spy
// satellite — "TOP SECRET // SI-TK // NOFORN", a random KH11 mission id, a blinking REC, orbit and
// pass numbers, MGRS, GSD/NIIRS image-quality scores, off-nadir angle, BAND/BITS/LVL. None of it is
// data, and the owner asked for it gone. What IS data stays: latitude/longitude, altitude, sun
// elevation, the UTC clock, the style label and the place summary. The page is titled "wildeye".
//
// hud.js is driven live with a DOM stub that has an #intel-hud element, so the check reads the
// markup the HUD actually builds, not the source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { IntelHUD } = await import('./hud.js');

const REMOVED = [/TOP SECRET/, /NOFORN/, /SI-TK/, /KH11/, /\bOPS-\d/, /PAGE 1\/1/, /\bREC\b/, /ORB:/, /PASS:/, /MGRS/, /GSD/, /NIIRS/, /\bONA\b/, /COLL:/, /BAND:/, /BITS:/, /LVL:/, /SECTOR/, /WINDOW/];

function buildHud() {
  const texts = new Map();
  const hudEl = { innerHTML: '', dataset: {} };
  const previous = globalThis.document;
  globalThis.document = {
    getElementById: (id) => {
      if (id === 'intel-hud') return hudEl;
      if (!new RegExp(`id="${id}"`).test(hudEl.innerHTML)) return null;
      if (!texts.has(id)) texts.set(id, { textContent: '', style: {} });
      return texts.get(id);
    },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const viewer = {
    camera: {
      pitch: -Math.PI / 2,
      positionCartographic: { latitude: (-25 * Math.PI) / 180, longitude: (134 * Math.PI) / 180, height: 9_000_000 },
      computeViewRectangle: () => undefined,
      moveEnd: { addEventListener() {}, removeEventListener() {} },
    },
  };
  const hud = new IntelHUD(viewer);
  hud._updateCameraData();
  const shown = [...texts.values()].map((t) => t.textContent).join('\n');
  return { hud, markup: hudEl.innerHTML, shown, texts, restore: () => { hud.destroy?.(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; } };
}

test('the HUD shows lat/lon, altitude, sun, clock, mode and summary — and none of the spy-thriller readouts', () => {
  const h = buildHud();
  try {
    for (const id of ['hud-latlon', 'hud-alt', 'hud-timestamp', 'hud-mode', 'hud-summary']) {
      assert.match(h.markup, new RegExp(`id="${id}"`), `positive control: #${id} is still built`);
    }
    assert.match(h.texts.get('hud-latlon').textContent, /^\d\d°\d\d'\d\d\.\d\d"S \d{3}°\d\d'\d\d\.\d\d"E$/, 'lat/lon still updates');
    assert.match(h.texts.get('hud-alt').textContent, /ALT: \d+m .*SUN: -?\d+\.\d° EL/, 'altitude and sun still update');
    const summary = h.hud._composeSummary();
    assert.match(summary, /\| ALT [\d.]+KM \|/, 'positive control: the summary still carries the altitude');
    for (const bad of REMOVED) {
      assert.doesNotMatch(h.markup, bad, `HUD markup still contains ${bad}`);
      assert.doesNotMatch(h.shown, bad, `a live readout still prints ${bad}`);
      assert.doesNotMatch(summary, bad, `the summary line still says ${bad}`);
    }
  } finally {
    h.restore();
  }
});

test('the page is titled wildeye, with no tagline', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<title>wildeye<\/title>/);
  assert.doesNotMatch(html, /GOD'S EYE|God's Eye|NO PLACE LEFT BEHIND/);
  assert.equal((html.match(/>wildeye</g) || []).length >= 2, true, 'the title bar and the loading screen both say wildeye');
});

test('the dev-server summary prompt asks for a place summary, not an intelligence one', () => {
  const cfg = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  // Boolean probes: a failed match on the whole config would print all of it.
  assert.equal(/intelligence-HUD|summary for God's Eye View/.test(cfg), false, 'the prompt still asks for an intelligence-HUD summary');
  assert.equal(/Output exactly five words/.test(cfg), true, 'positive control: the rest of the prompt is untouched');
});

