// src/data/crwOutlook.test.mjs — the NOAA CRW four-month outlook: cell lookup, the words for a cell, the readout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, NOT_COVERED, cellIndex, createCrwOutlookLayer, outlookText } from './crwOutlook.js';

const ENTRY = {
  id: 'crw-outlook', png: 'data/rasters/crw-outlook.png', time: '2026-09-29T00:00:00Z', bounds: { west: -180, south: -90, east: 180, north: 90 },
  outlook: { start: '2026-10-05', end: '2027-01-31', issued: '2026-09-29', icwk: '20260927', probabilities: [60, 90], data_png: 'data/rasters/crw-outlook.data.png' },
};

test('cell lookup: west to east from -180, north to south from 90, edges inside the grid', () => {
  assert.equal(cellIndex(89.9, -179.9), 0);
  assert.equal(cellIndex(89.9, 179.9), 719);
  assert.equal(cellIndex(-89.9, -179.9), 359 * 720);
  // the poles fall in the edge rows, not off the grid; 180°E is -180°, the west edge of column 0
  assert.equal(cellIndex(90, 180), 0);
  assert.equal(cellIndex(90, -180), 0);
  assert.equal(cellIndex(-90, -180), 359 * 720);
  // Fiji, 17.75°S 178.25°E: row (90 + 17.75) / 0.5 = 215, column (178.25 + 180) / 0.5 = 716
  assert.equal(cellIndex(-17.75, 178.25), 215 * 720 + 716);
  assert.equal(cellIndex(-17.75, 178.25 - 360), 215 * 720 + 716);
  assert.equal(cellIndex(0.1, 0.1), 179 * 720 + 360);
  assert.equal(cellIndex(-0.1, -0.1), 180 * 720 + 359);
});

test('the words: the level at P% is what P% of runs reach, so 0 is "fewer than P% reach Watch"', () => {
  assert.deepEqual(LEVELS, ['no stress', 'Watch', 'Warning', 'Alert Level 1', 'Alert Level 2']);
  assert.equal(outlookText(4, 2), 'Alert Level 2 reached by 60% of model runs; Warning by 90%');
  assert.equal(outlookText(3, 0), 'Alert Level 1 reached by 60% of model runs; fewer than 90% reach Watch');
  assert.equal(outlookText(4, 4), 'Alert Level 2 reached by 90% of model runs');
  assert.equal(outlookText(0, 0), 'No stress: fewer than 60% of model runs reach Watch');
  assert.equal(outlookText(2, 1, [50, 80]), 'Warning reached by 50% of model runs; Watch by 80%');
});

/** A readout image: every cell `fill`, with `cells` = { index: [low, high] } overridden. */
function image(cells = {}, fill = [0, 0], { width = 720, height = 360 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([fill[0], fill[1], 0, 255], i * 4);
  for (const [i, [low, high]] of Object.entries(cells)) data.set([low, high, 0, 255], Number(i) * 4);
  return { width, height, data };
}

function harness({ entry = ENTRY, decoded = image(), failDecode = null } = {}) {
  const decodes = [];
  const layer = createCrwOutlookLayer({
    decodeImage: async (url) => { decodes.push(url); if (failDecode) throw failDecode; return decoded; },
    providerFor: async () => ({}),
    imageryLayerFor: () => ({ show: true }),
  });
  const viewer = { imageryLayers: { add() {}, remove() { return true; }, contains: () => true } };
  layer.init(viewer);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ products: [entry] }) });
  return { layer, decodes };
}

test('the readout reads both probabilities for the cell, labelled with the outlook window', async () => {
  const fiji = cellIndex(-17.75, 178.25);
  const { layer, decodes } = harness({ decoded: image({ [fiji]: [4, 2], [fiji + 1]: [1, 1] }) });
  layer.enable();
  assert.equal(await layer.update(), true);
  const r = await layer.readoutAt(-17.75, 178.25);
  assert.deepEqual(r, {
    id: 'crw-outlook', name: layer.name, icon: '🔮', status: 'value', text: 'Alert Level 2 reached by 60% of model runs; Warning by 90%',
    date: 'outlook 2026-10-05 to 2027-01-31',
  });
  assert.equal((await layer.readoutAt(-17.75, 178.75)).text, 'Watch reached by 90% of model runs'); // the next cell east
  assert.deepEqual(decodes, ['data/rasters/crw-outlook.data.png?20260927']); // read once per issue
  layer.disable();
  assert.equal(await layer.readoutAt(-17.75, 178.25), null);
});

test('land, a missing outlook, a bad image or a cell that breaks the rules each say so', async () => {
  const at = cellIndex(10, 10);
  let h = harness({ decoded: image({ [at]: [NOT_COVERED, NOT_COVERED] }) });
  h.layer.enable();
  await h.layer.update();
  assert.deepEqual([(await h.layer.readoutAt(10, 10)).status, (await h.layer.readoutAt(10, 10)).date], ['nodata', 'outlook 2026-10-05 to 2027-01-31']);
  assert.equal((await h.layer.readoutAt(10.5, 10)).status, 'value'); // positive control: the cell north is water

  const { outlook, ...noOutlook } = ENTRY;
  h = harness({ entry: noOutlook });
  h.layer.enable();
  await h.layer.update();
  assert.equal((await h.layer.readoutAt(10, 10)).status, 'gap');

  for (const [decoded, error] of [
    [image({ [at]: [1, 3] }), /levels 1\/3/], // 90% above 60%: impossible, so the image is not what we think
    [image({ [at]: [7, 0] }), /levels 7\/0/],
    [image({}, [0, 0], { width: 360, height: 180 }), /360×180, not 720×360/],
  ]) {
    h = harness({ decoded });
    h.layer.enable();
    await h.layer.update();
    const r = await h.layer.readoutAt(10, 10);
    assert.equal(r.status, 'error');
    assert.match(r.error, error);
  }
  h = harness({ failDecode: new Error('outlook readout image HTTP 404') });
  h.layer.enable();
  await h.layer.update();
  assert.deepEqual([(await h.layer.readoutAt(10, 10)).status, (await h.layer.readoutAt(10, 10)).error], ['error', 'outlook readout image HTTP 404']);
  assert.equal(h.decodes.length, 2); // a failed read is retried on the next click, not cached
});

test('a new issue is read afresh; the legend lists the four drawn levels and the dated caption', async () => {
  const at = cellIndex(-17.75, 178.25);
  const { layer, decodes } = harness({ decoded: image({ [at]: [2, 0] }) });
  layer.enable();
  await layer.update();
  await layer.readoutAt(-17.75, 178.25);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ products: [{ ...ENTRY, time: '2026-10-06T00:00:00Z', png: 'data/rasters/crw-outlook.png', outlook: { ...ENTRY.outlook, icwk: '20261004' }, legend: 'Four-month outlook …', classes: [
    { label: 'no stress', rgb: [255, 255, 255], hidden: true }, { label: 'Watch', rgb: [255, 210, 160] }, { label: 'Warning', rgb: [250, 170, 10] },
    { label: 'Alert Level 1', rgb: [240, 0, 0] }, { label: 'Alert Level 2', rgb: [150, 0, 0] }] }] }) });
  await layer.update();
  await layer.readoutAt(-17.75, 178.25);
  assert.deepEqual(decodes, ['data/rasters/crw-outlook.data.png?20260927', 'data/rasters/crw-outlook.data.png?20261004']);
  const { legend } = layer.getRowControls();
  assert.deepEqual(legend.map((l) => l.label), ['Watch', 'Warning', 'Alert Level 1', 'Alert Level 2', 'Four-month outlook …']);
  assert.equal(legend[3].color, 'rgb(150,0,0)');
});
