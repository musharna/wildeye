// src/data/surfaceWater.test.mjs — the JRC surface-water layer: colour table, drape lifecycle, readout, loud failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSurfaceWaterLayer,
  decodeOccurrence,
  occurrenceColour,
  MAX_LEVEL,
  PERIOD,
  SURFACE_WATER_URL,
  TILE_FAILURE_LIMIT,
} from './surfaceWater.js';
import { gibsTileRequest } from './gibsReadout.js';

function harness({ pixel = occurrenceColour(37), readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createSurfaceWaterLayer({
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
      if (readError) throw readError;
      return { rgba: pixel, timeActual: null };
    },
  });
  layer.init(viewer);
  return { layer, providers, reads, list, stacked };
}

test('colour table: 100 distinct colours, the formula except k=80 as the tiles carry it; anything else is unrecognised', () => {
  const colours = Array.from({ length: 100 }, (_, i) => occurrenceColour(i + 1));
  assert.equal(new Set(colours.map(String)).size, 100);
  assert.deepEqual(occurrenceColour(1), [252, 0, 2, 3]);
  assert.deepEqual(occurrenceColour(37), [160, 0, 94, 94]);
  assert.deepEqual(occurrenceColour(80), [50, 0, 204, 204], 'the tiles carry R=50 at 80%, not the formula\'s 51');
  assert.deepEqual(occurrenceColour(100), [0, 0, 255, 255]);
  for (let k = 1; k <= 100; k++) assert.deepEqual(decodeOccurrence(occurrenceColour(k)), { kind: 'value', percent: k }, `k=${k}`);
  assert.deepEqual(decodeOccurrence([0, 0, 0, 0]), { kind: 'none' });
  assert.deepEqual(decodeOccurrence([7, 7, 7, 0]), { kind: 'none' }, 'any fully transparent pixel is no water');
  for (const odd of [[51, 0, 204, 204], [2, 0, 252, 255], [0, 255, 0, 255], [160, 0, 94, 95]]) {
    assert.deepEqual(decodeOccurrence(odd), { kind: 'unknown', rgba: odd }, `${odd} is named, not snapped`);
  }
  assert.throws(() => occurrenceColour(0), /1–100/);
  assert.throws(() => occurrenceColour(101), /1–100/);
});

test('the drape: one provider on the 2021 occurrence tiles to z13, built once, shown only while enabled', async () => {
  assert.equal(SURFACE_WATER_URL, 'https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png');
  assert.equal(MAX_LEVEL, 13);
  const { layer, providers, list, stacked } = harness();
  assert.equal(await layer.update(), true);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].options.url, SURFACE_WATER_URL);
  assert.equal(providers[0].options.maximumLevel, 13);
  assert.match(providers[0].options.credit, /EC JRC\/Google/);
  assert.equal(list.length, 1);
  assert.equal(list[0].show, false, 'registered off');
  assert.equal(stacked.at(-1).id, 'surface-water');
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  layer.disable();
  assert.equal(list[0].show, false);
  assert.equal(layer.getStats().time, PERIOD);
  assert.equal(layer.getObservedExtent, undefined, 'not on the time bar');
  layer.destroy();
  assert.equal(list.length, 0);
  assert.equal(stacked.at(-1).imagery, null);
});

test('tile failures: the limit marks the layer failing, the next update rebuilds it, a replaced provider is ignored', async () => {
  const { layer, providers } = harness();
  layer.enable();
  await layer.update();
  for (let i = 0; i < TILE_FAILURE_LIMIT - 1; i++) providers[0].fail(new Error('net'));
  assert.equal(layer.getStats().error, null, 'below the limit');
  providers[0].fail(new Error('net'));
  assert.equal(layer.getStats().error, 'map tiles failing');
  await layer.update();
  assert.equal(providers.length, 2, 'Cesium never re-requests a failed tile: a fresh provider is the retry');
  assert.equal(layer.getStats().error, null);
  for (let i = 0; i < TILE_FAILURE_LIMIT; i++) providers[0].fail(new Error('net'));
  assert.equal(layer.getStats().error, null, 'the old provider no longer counts');
});

test('readout: occurrence at z13 from the raw tile; no water; outside the data on 404; other failures and colours are loud', async () => {
  const lat = -1.0, lon = 33.0;
  const h = harness();
  assert.equal(await h.layer.readoutAt(lat, lon), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const water = await h.layer.readoutAt(lat, lon);
  assert.equal(water.status, 'value');
  assert.equal(water.text, 'Water in 37% of months');
  assert.equal(water.date, PERIOD);
  assert.deepEqual(h.reads.at(-1), gibsTileRequest(SURFACE_WATER_URL, 13, lat, lon));

  const dry = await harness({ pixel: [0, 0, 0, 0] });
  dry.layer.enable();
  const none = await dry.layer.readoutAt(23.5, 12.0);
  assert.equal(none.status, 'class');
  assert.equal(none.text, 'No surface water seen');
  assert.equal(none.date, PERIOD);

  const odd = harness({ pixel: [51, 0, 204, 204] });
  odd.layer.enable();
  const unknown = await odd.layer.readoutAt(lat, lon);
  assert.equal(unknown.status, 'error');
  assert.match(unknown.error, /unrecognised pixel 51,0,204,204/);

  const beyond = harness({ readError: Object.assign(new Error('GIBS tile HTTP 404'), { status: 404 }) });
  beyond.layer.enable();
  assert.equal((await beyond.layer.readoutAt(80, 20)).status, 'outside');

  const broken = harness({ readError: Object.assign(new Error('GIBS tile HTTP 503'), { status: 503 }) });
  broken.layer.enable();
  const failed = await broken.layer.readoutAt(lat, lon);
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /503/);

  assert.equal((await h.layer.readoutAt(89, 0)).status, 'outside', 'beyond the mercator limit no tile is read');
});

test('legend: a ramp of sampled percents in their tile colours, plus the source line', () => {
  const { layer } = harness();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, -1).map((e) => e.label), ['10%', '25%', '50%', '75%', '100%']);
  const [r, g, b, a] = occurrenceColour(50);
  assert.equal(legend[2].color, `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`);
  assert.match(legend.at(-1).label, /months with water, 1984–2021/);
});
