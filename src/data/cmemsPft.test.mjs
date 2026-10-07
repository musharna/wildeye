// src/data/cmemsPft.test.mjs — dominant phytoplankton group: cell lookup, month label, colour → class, readout, legend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HEIGHT, NO_ESTIMATE, WIDTH, cellIndex, classOfPixel, createCmemsPftLayer, monthLabel } from './cmemsPft.js';

const PRODUCT = JSON.parse(readFileSync(new URL('../../pipeline/rasters.json', import.meta.url), 'utf8')).find((p) => p.id === 'cmems-pft');
const CLASSES = PRODUCT.classes;
const ENTRY = {
  id: 'cmems-pft', png: 'data/rasters/cmems-pft.png', time: '2026-09-01T00:00:00Z', bounds: PRODUCT.bounds, classes: CLASSES, legend: PRODUCT.legend,
  history: [
    { time: '2026-08-01T00:00:00Z', png: 'data/rasters/cmems-pft/20260801T000000Z.png' },
    { time: '2026-09-01T00:00:00Z', png: 'data/rasters/cmems-pft/20260901T000000Z.png' },
  ],
};

test('cell lookup: 0.25° cells west to east from -180, north to south from 90, edges inside the grid', () => {
  assert.equal(cellIndex(89.9, -179.9), 0);
  assert.equal(cellIndex(89.9, 179.9), WIDTH - 1);
  assert.equal(cellIndex(-89.9, -179.9), (HEIGHT - 1) * WIDTH);
  assert.equal(cellIndex(90, 180), 0);
  assert.equal(cellIndex(-90, 180), (HEIGHT - 1) * WIDTH);
  // the Arabian Sea cell 15.0–15.25°N 62.0–62.25°E: row (90 - 15.125) / 0.25 = 299, column (62.125 + 180) / 0.25 = 968
  assert.equal(cellIndex(15.125, 62.125), 299 * WIDTH + 968);
  assert.equal(cellIndex(15.125, 62.125 - 360), 299 * WIDTH + 968);
  assert.equal(cellIndex(0.1, 0.1), 359 * WIDTH + 720);
  assert.equal(cellIndex(-0.1, -0.1), 360 * WIDTH + 719);
});

test('a frame is named by its month; anything else is null', () => {
  assert.equal(monthLabel('2026-09-01T00:00:00Z'), 'September 2026');
  assert.equal(monthLabel('2027-01-01T00:00:00Z'), 'January 2027');
  assert.equal(monthLabel('2026-12-01'), 'December 2026');
  assert.equal(monthLabel('2026-13-01T00:00:00Z'), null);
  assert.equal(monthLabel(null), null);
});

test('a pixel reads as the class painted in exactly its colour, clear as no estimate, anything else throws', () => {
  assert.equal(classOfPixel(CLASSES, [230, 159, 0, 255]), 'diatoms');
  assert.equal(classOfPixel(CLASSES, [240, 228, 66, 255]), 'prokaryotes (cyanobacteria)');
  assert.equal(classOfPixel(CLASSES, [0, 0, 0, 0]), NO_ESTIMATE);
  assert.throws(() => classOfPixel(CLASSES, [230, 159, 1, 255]), /230,159,1,255 is not a class colour/);
  assert.throws(() => classOfPixel(CLASSES, [230, 159, 0, 128]), /230,159,0,128 is not a class colour/); // blended, not painted
});

/** A frame: every cell clear, with `cells` = { index: [r, g, b] } painted opaque. */
function image(cells = {}, { width = WIDTH, height = HEIGHT } = {}) {
  const data = new Uint8Array(width * height * 4);
  for (const [i, rgb] of Object.entries(cells)) data.set([...rgb, 255], Number(i) * 4);
  return { width, height, data };
}

function harness({ entry = ENTRY, frames = {}, failDecode = null } = {}) {
  const decodes = [];
  const layer = createCmemsPftLayer({
    decodeImage: async (url) => {
      decodes.push(url);
      if (failDecode) throw failDecode;
      return frames[url.split('?')[0]] ?? image();
    },
    providerFor: async () => ({}),
    imageryLayerFor: () => ({ show: true }),
  });
  layer.init({ imageryLayers: { add() {}, remove() { return true; }, contains: () => true } });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ products: [entry] }) });
  return { layer, decodes };
}

const ARABIAN = cellIndex(15.125, 62.125);

test('the readout names the group of the cell in the frame on show, dated by its month', async () => {
  const frames = { 'data/rasters/cmems-pft.png': image({ [ARABIAN]: [86, 180, 233], [ARABIAN + 1]: [230, 159, 0] }) };
  const { layer, decodes } = harness({ frames });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.deepEqual(await layer.readoutAt(15.125, 62.125), {
    id: 'cmems-pft', name: 'Dominant phytoplankton group', icon: '🔬', status: 'class', text: 'haptophytes (coccolithophores and relatives)', date: 'September 2026',
  });
  assert.equal((await layer.readoutAt(15.125, 62.375)).text, 'diatoms'); // the next cell east
  assert.equal((await layer.readoutAt(15.375, 62.125)).text, NO_ESTIMATE); // the cell north is clear
  assert.deepEqual(decodes, ['data/rasters/cmems-pft.png?t=2026-09-01T00:00:00Z']); // read once per frame
  layer.disable();
  assert.equal(await layer.readoutAt(15.125, 62.125), null);
});

test('on the time bar the readout follows the month shown, and a time before every frame is a gap', async () => {
  const frames = {
    'data/rasters/cmems-pft/20260801T000000Z.png': image({ [ARABIAN]: [0, 158, 115] }),
    'data/rasters/cmems-pft.png': image({ [ARABIAN]: [86, 180, 233] }),
  };
  const { layer } = harness({ frames });
  layer.enable();
  await layer.update();
  await layer.setObservedTime('2026-08-20T12:00:00Z');
  assert.deepEqual([(await layer.readoutAt(15.125, 62.125)).text, (await layer.readoutAt(15.125, 62.125)).date], ['green algae and prochlorophytes', 'August 2026']);
  await layer.setObservedTime('2026-09-03T00:00:00Z');
  assert.equal((await layer.readoutAt(15.125, 62.125)).date, 'September 2026');
  await layer.setObservedTime('2026-07-31T00:00:00Z');
  assert.deepEqual(await layer.readoutAt(15.125, 62.125), {
    id: 'cmems-pft', name: 'Dominant phytoplankton group', icon: '🔬', status: 'gap', text: null, date: null, observed: '2026-07-31T00:00:00Z',
  });
  await layer.setObservedTime(null); // back to live: the latest
  assert.equal((await layer.readoutAt(15.125, 62.125)).text, 'haptophytes (coccolithophores and relatives)');
});

test('a wrong-size frame, a foreign colour or a failed read each say so, and a failed read is retried', async () => {
  let h = harness({ frames: { 'data/rasters/cmems-pft.png': image({}, { width: 720, height: 360 }) } });
  h.layer.enable();
  await h.layer.update();
  let r = await h.layer.readoutAt(15.125, 62.125);
  assert.deepEqual([r.status, r.error, r.date], ['error', 'phytoplankton frame is 720×360, not 1440×720', 'September 2026']);

  h = harness({ frames: { 'data/rasters/cmems-pft.png': image({ [ARABIAN]: [1, 2, 3] }) } });
  h.layer.enable();
  await h.layer.update();
  r = await h.layer.readoutAt(15.125, 62.125);
  assert.equal(r.status, 'error');
  assert.match(r.error, /1,2,3,255 is not a class colour/);

  h = harness({ failDecode: new Error('phytoplankton frame HTTP 404') });
  h.layer.enable();
  await h.layer.update();
  assert.equal((await h.layer.readoutAt(15.125, 62.125)).error, 'phytoplankton frame HTTP 404');
  await h.layer.readoutAt(15.125, 62.125);
  assert.equal(h.decodes.length, 2);

  h = harness({ entry: null });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ products: [] }) });
  h.layer.enable();
  await h.layer.update();
  assert.equal((await h.layer.readoutAt(15.125, 62.125)).status, 'gap');
});

test('the legend: the five groups in their colours, then the caption, word for word', async () => {
  const { layer } = harness();
  await layer.update();
  const { legend } = layer.getRowControls();
  assert.deepEqual(legend.map((l) => [l.label, l.color]), [
    ['diatoms', 'rgb(230,159,0)'],
    ['dinoflagellates', 'rgb(204,121,167)'],
    ['haptophytes (coccolithophores and relatives)', 'rgb(86,180,233)'],
    ['green algae and prochlorophytes', 'rgb(0,158,115)'],
    ['prokaryotes (cyanobacteria)', 'rgb(240,228,66)'],
    ['group with the most chlorophyll in each cell, satellite estimate, monthly mean; clear = no satellite view', 'transparent'],
  ]);
});
