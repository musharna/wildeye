// src/data/lossDrivers.test.mjs — forest loss drivers drape: the GFW v1.13 dynamic tile URL, the colour table against
// GFW's renderer and the raw-data check, the readout's pixel decoding and level, wiring, legend and credit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  DRIVERS,
  MAX_LEVEL,
  READOUT_LEVEL,
  TILE_FAILURE_LIMIT,
  TILE_SIZE,
  createLossDriversLayer,
  decodeDriverPixel,
  driversTileUrl,
  lossDriversLayer,
} from './lossDrivers.js';
import { gibsTileRequest } from './gibsReadout.js';
import { DataLayerManager } from './manager.js';
import { installDrapeExclusivity } from './drapeExclusive.js';
import { DATA_CREDITS } from './dataCredits.js';
import { LAYER_GROUPS } from './layerGroups.js';

const repo = (p) => new URL(`../../${p}`, import.meta.url);
const main = readFileSync(repo('src/main.js'), 'utf8');

test('the drape is GFW\'s v1.13 dynamic tiles at 30% canopy: 512-px web-mercator XYZ to level 12', async () => {
  assert.equal(
    driversTileUrl(7, 40, 63),
    'https://tiles.globalforestwatch.org/wri_google_tree_cover_loss_drivers/v1.13/dynamic/7/40/63.png?implementation=default&tree_cover_density_threshold=30',
  );
  const options = [];
  const layer = createLossDriversLayer({
    providerFor: (o) => { options.push(o); return new Cesium.UrlTemplateImageryProvider(o); },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: () => {},
  });
  const list = [];
  layer.init({ imageryLayers: { add: (l) => list.push(l), remove: () => true } });
  layer.enable();
  assert.equal(await layer.update(), true);
  const p = list[0].provider;
  assert.ok(p.tilingScheme instanceof Cesium.WebMercatorTilingScheme);
  assert.deepEqual([p.tileWidth, p.tileHeight, p.maximumLevel], [512, 512, 12]);
  assert.equal(TILE_SIZE, 512);
  assert.equal(MAX_LEVEL, 12);
  assert.equal(p.url, driversTileUrl('{z}', '{x}', '{y}'));
  assert.equal(options[0].tilingScheme, undefined);
});

test('DRIVERS is GFW\'s renderer table: codes 1–7, one distinct colour each, none black', () => {
  // wri/gfw-tile-cache app/routes/titiler/algorithms/tree_cover_loss_drivers.py @ae9100aabc, conf_colors
  const gfw = { 1: [227, 157, 41], 2: [229, 128, 116], 3: [233, 215, 0], 4: [81, 164, 78], 5: [137, 81, 40], 6: [163, 84, 160], 7: [58, 32, 154] };
  assert.deepEqual(Object.fromEntries(DRIVERS.map((d) => [d.code, [...d.rgb]])), gfw);
  assert.equal(new Set(DRIVERS.map((d) => String(d.rgb))).size, 7);
  assert.ok(DRIVERS.every((d) => d.rgb.some((c) => c > 0)), 'black means no driver, so no driver may be black');
  assert.deepEqual(DRIVERS.map((d) => d.name), ['Permanent agriculture', 'Hard commodities (mining, energy)', 'Shifting cultivation',
    'Logging', 'Wildfire', 'Settlements and infrastructure', 'Other natural disturbances']);
});

test('a pixel names its driver at any alpha; black is no driver; any other colour is unrecognised, not snapped', () => {
  for (const d of DRIVERS) {
    for (const a of [0, 36, 255]) assert.equal(decodeDriverPixel([...d.rgb, a]).driver, d, `${d.name} at alpha ${a}`);
  }
  assert.deepEqual(decodeDriverPixel([0, 0, 0, 0]), { kind: 'none' });
  assert.deepEqual(decodeDriverPixel([0, 0, 0, 255]), { kind: 'none' });
  // one off in each channel from a real colour
  for (const rgba of [[228, 157, 41, 255], [227, 156, 41, 255], [227, 157, 42, 9]]) {
    assert.deepEqual(decodeDriverPixel(rgba), { kind: 'unknown', rgba });
  }
});

test('the readout reads the level the raw-data check found exact at every point; the coarser level it rejected is not used', () => {
  // docs/analysis/loss_drivers_tiles_vs_raw.md, written by analysis/loss_drivers_tiles_vs_raw.py from the raw GeoTIFFs
  const doc = readFileSync(repo('docs/analysis/loss_drivers_tiles_vs_raw.md'), 'utf8');
  const scores = Object.fromEntries([...doc.matchAll(/- level (\d+): the drawn colour names the raw class at (\d+) of (\d+) points/g)]
    .map((m) => [Number(m[1]), [Number(m[2]), Number(m[3])]]));
  assert.ok(scores[12] && scores[8], 'positive control: both levels were scored');
  const [ok, n] = scores[READOUT_LEVEL];
  assert.ok(n >= 100, `points checked: ${n}`);
  assert.equal(ok, n, `level ${READOUT_LEVEL}: ${ok} of ${n}`);
  assert.ok(scores[8][0] < scores[8][1], 'control: level 8 disagreed somewhere, so the check can fail');
  const seen = doc.match(/raw classes seen: \[([\d, ]+)\]/)[1].split(',').map(Number);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
});

function harness({ pixel = [137, 81, 40, 0], fail = null } = {}) {
  const providers = [], list = [], stacked = [], reads = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; } } };
  const layer = createLossDriversLayer({
    providerFor: (options) => {
      const listeners = [];
      const p = { options, errorEvent: { addEventListener: (fn) => listeners.push(fn) }, fail: (error) => listeners.forEach((fn) => fn({ error })) };
      providers.push(p);
      return p;
    },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: (_layers, id, imagery, zrank) => stacked.push({ id, imagery, zrank }),
    readTilePixel: async (url, px, py) => {
      reads.push({ url, px, py });
      if (fail) throw fail;
      return { rgba: pixel };
    },
  });
  layer.init(viewer);
  return { layer, providers, list, stacked, reads };
}

test('readout: the cell\'s driver from the readout-level tile, even where its pixel is clear; none, odd, error, outside, off', async () => {
  const lat = 56.0, lon = -122.5;
  const h = harness();
  assert.equal(await h.layer.readoutAt(lat, lon), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(lat, lon);
  assert.deepEqual([r.id, r.status, r.text, r.date], ['loss-drivers', 'class', 'Wildfire', '2001–2025']);
  assert.deepEqual(h.reads.at(-1), gibsTileRequest(driversTileUrl('{z}', '{x}', '{y}'), READOUT_LEVEL, lat, lon, 512));

  const none = harness({ pixel: [0, 0, 0, 0] });
  none.layer.enable();
  const n = await none.layer.readoutAt(lat, lon);
  assert.deepEqual([n.status, n.text, n.date], ['class', 'No loss driver mapped', '2001–2025']);

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  const o = await odd.layer.readoutAt(lat, lon);
  assert.equal(o.status, 'error');
  assert.match(o.error, /unrecognised pixel 1,2,3,255/);

  const bad = harness({ fail: new Error('GIBS tile HTTP 503') });
  bad.layer.enable();
  const origError = console.error;
  console.error = () => {};
  try {
    const b = await bad.layer.readoutAt(lat, lon);
    assert.deepEqual([b.status, b.error], ['error', 'GIBS tile HTTP 503']);
  } finally {
    console.error = origError;
  }

  const far = await h.layer.readoutAt(89.5, 0);
  assert.equal(far.status, 'outside');
});

test('wiring: registered, a drape, read on click, in Human impact after forest loss, link token ld; not on the time bar', () => {
  assert.match(main, /import \{ lossDriversLayer \} from '\.\/data\/lossDrivers\.js';/);
  assert.match(main, /dataManager\.register\(lossDriversLayer\);/);
  const list = (re) => main.match(re)?.[1].split(',').map((s) => s.trim());
  const drapes = list(/const drapeLayers = \[([^\]]+)\];/);
  const reads = list(/const readGibsLayers = \(\{ lat, lon \}\) => \[\n\s*\.\.\.\[([^\]]+)\]/);
  const observed = list(/const observedLayers = \[([^\]]+)\];/);
  assert.ok(drapes?.includes('hansenLossLayer') && reads?.includes('hansenLossLayer') && observed?.includes('hansenLossLayer'),
    'positive control: the three lists were found');
  assert.ok(drapes.includes('lossDriversLayer'));
  assert.ok(reads.includes('lossDriversLayer'));
  assert.ok(!observed.includes('lossDriversLayer'));
  assert.equal(lossDriversLayer.setObservedTime, undefined);
  assert.equal(lossDriversLayer.getStats().time, '2001–2025');
  const human = LAYER_GROUPS.find((g) => g.id === 'human').layers;
  assert.equal(human.indexOf('loss-drivers'), human.indexOf('hansen-loss') + 1);
});

test('one drape at a time: turning it on turns forest loss off, and the other way round', async () => {
  const fake = (id) => ({ id, name: id, icon: '', source: 't', updateInterval: -1, async init() {}, enable() {}, disable() {}, async update() { return true; }, getStats() { return { count: 0, lastUpdate: null }; } });
  const run = async (ids) => {
    const mgr = new DataLayerManager({});
    for (const id of ['loss-drivers', 'hansen-loss']) mgr.register(fake(id));
    installDrapeExclusivity(mgr, ids);
    await mgr.setEnabled('hansen-loss', true, { origin: 'user' });
    await mgr.setEnabled('loss-drivers', true, { origin: 'user' });
    const a = [mgr.isEnabled('hansen-loss'), mgr.isEnabled('loss-drivers')];
    await mgr.setEnabled('hansen-loss', true, { origin: 'user' });
    return [...a, mgr.isEnabled('loss-drivers')];
  };
  assert.deepEqual(await run(['hansen-loss', 'loss-drivers']), [false, true, false]);
  assert.deepEqual(await run(['hansen-loss']), [true, true, true]); // control: left out of the list, the two stack
});

test('draws once, stacked with the forest drapes; enable and disable show and hide it without a redraw', async () => {
  const { layer, providers, list, stacked } = harness();
  assert.equal(await layer.update(), true);
  assert.equal(list[0].show, false); // built while off
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1);
  assert.deepEqual(stacked.at(-1), { id: 'loss-drivers', imagery: list[0], zrank: 20 });
  layer.disable();
  assert.equal(list[0].show, false);
  await layer.update();
  assert.equal(list[0].show, false);
  assert.equal(providers.length, 1);
  layer.destroy();
  assert.equal(list.length, 0);
  assert.equal(await layer.update(), false); // no viewer
});

test('tile failures surface at the limit; the next update rebuilds, and the old provider no longer counts', async () => {
  const { layer, providers } = harness();
  layer.enable();
  await layer.update();
  const origError = console.error;
  console.error = () => {};
  try {
    for (let k = 0; k < TILE_FAILURE_LIMIT - 1; k++) providers[0].fail(new Error('x'));
    assert.equal(layer.getStats().error, null);
    providers[0].fail(new Error('x'));
    assert.equal(layer.getStats().error, 'map tiles failing');
    await layer.update();
    assert.equal(providers.length, 2);
    assert.equal(layer.getStats().error, null);
    for (let k = 0; k < TILE_FAILURE_LIMIT; k++) providers[0].fail(new Error('late'));
    assert.equal(layer.getStats().error, null);
  } finally {
    console.error = origError;
  }
});

test('legend: a swatch per driver in its colour, then the source line', () => {
  const { legend } = lossDriversLayer.getRowControls();
  assert.equal(legend.length, DRIVERS.length + 1);
  for (const [i, d] of DRIVERS.entries()) assert.deepEqual([legend[i].label, legend[i].color], [d.name, `rgb(${d.rgb.join(',')})`]);
  assert.match(legend.at(-1).label, /1 km cell, 2001–2025, 30% canopy/);
  assert.match(legend.at(-1).label, /CC BY 4\.0/);
  assert.equal(legend.at(-1).color, 'transparent');
});

test('credit: GFW\'s display credit and the dataset\'s citation, verbatim; CC BY 4.0', () => {
  const c = DATA_CREDITS.find((e) => e.key === 'loss-drivers');
  assert.ok(c, 'DATA_CREDITS has a loss-drivers entry');
  // the data API's dataset metadata `citation` (read 2026-10-25); DOI CrossRef-checked the same day
  assert.ok(c.html.includes('“Tree cover loss by dominant driver”. WRI/Google DeepMind. Accessed from <a href="https://www.globalnaturewatch.org"'));
  assert.ok(c.html.includes('Sims, M.J., R. Stanimirova, A. Raichuk, M. Neumann, J. Richter, F. Follett, J. MacCarthy, K. Lister, C. Randle, L. Sloat, E. Esipova, J. Jupiter, C. Stanton, D. Morris, C. M. Slay, D. Purves, and N. Harris. 2025. “Global Drivers of Forest Loss at 1 Km Resolution.” <i>Environmental Research Letters</i> 20 (7): 074027.'));
  assert.ok(c.html.includes('https://doi.org/10.1088/1748-9326/add606'));
  assert.ok(c.html.includes('https://creativecommons.org/licenses/by/4.0/'));
  assert.equal(lossDriversLayer.source, 'WRI / Google DeepMind via Global Forest Watch · CC BY 4.0');
});
