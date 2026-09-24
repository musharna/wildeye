import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGibsLayer } from './gibsLayer.js';

const { layers } = JSON.parse(readFileSync(new URL('./fixtures/gibs-readout.json', import.meta.url)));
const LST = { ...layers['gibs-lst'], times: ['2026-08-13/2026-08-21/P8D'] };
const LC = { ...layers['gibs-landcover'], times: ['2001-01-01/2024-01-01/P1Y'] };
const BM = { ...layers['gibs-nightlights'], times: ['2012-01-01/2016-01-01/P4Y'] };
const lstRgb = (lo) => LST.decode.find((e) => e[3] === lo).slice(0, 3);

async function harness(id, entry, { pixel = [0, 0, 0, 0], timeActual = null, fail = null } = {}) {
  const reads = [];
  const layer = createGibsLayer({
    id, name: id, icon: '·', source: 'NASA GIBS',
    fetchJson: async () => ({ layers: { [id]: entry } }),
    providerFor: (url) => ({ url, errorEvent: { addEventListener() {} } }),
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: () => {},
    readTilePixel: async (url, px, py) => {
      reads.push({ url, px, py });
      if (fail) throw new Error(fail);
      return { rgba: pixel, timeActual };
    },
  });
  layer.init({ imageryLayers: { add() {}, remove: () => true, contains: () => false } });
  await layer.update();
  layer.enable();
  return { layer, reads };
}

test("a layer reads its shown date's tile at its maximum level and labels the value with that date", async () => {
  const { layer, reads } = await harness('gibs-lst', LST, { pixel: [...lstRgb(298.4), 255], timeActual: '2026-08-21' });
  const r = await layer.readoutAt(41.88, -87.63);
  assert.equal(reads.length, 1);
  assert.match(reads[0].url, /\/MODIS_Terra_L3_Land_Surface_Temp_8Day_Day\/default\/2026-08-21\/GoogleMapsCompatible_Level7\/7\/\d+\/\d+\.png$/);
  assert.deepEqual(r, { id: 'gibs-lst', name: 'gibs-lst', icon: '·', status: 'value', text: '25.6 °C', date: '2026-08-21' });
});

test('a class layer reads its NASA label', async () => {
  const { layer } = await harness('gibs-landcover', LC, { pixel: [49, 204, 49, 255] });
  const r = await layer.readoutAt(-5, -65);
  assert.equal(r.status, 'class');
  assert.equal(r.text, 'Evergreen Broadleaf Forests');
  assert.equal(r.date, '2024-01-01');
});

test('a transparent pixel is no data on that date, not a value', async () => {
  const { layer } = await harness('gibs-lst', LST, { pixel: [64, 64, 64, 0] });
  const r = await layer.readoutAt(28.61, 77.21);
  assert.equal(r.status, 'nodata');
  assert.equal(r.text, null);
  assert.equal(r.date, '2026-08-21');
});

test('a layer in a gap reads no tile', async () => {
  const { layer, reads } = await harness('gibs-lst', LST, { pixel: [...lstRgb(298.4), 255] });
  await layer.setObservedTime('2020-01-01T00');
  const r = await layer.readoutAt(0, 0);
  assert.equal(r.status, 'gap');
  assert.equal(reads.length, 0);
  await layer.setObservedTime(null); // positive control: back to live, it reads again
  assert.equal((await layer.readoutAt(0, 0)).status, 'value');
});

test('night lights is view only and reads no tile', async () => {
  const { layer, reads } = await harness('gibs-nightlights', BM, { pixel: [255, 255, 255, 255] });
  const r = await layer.readoutAt(41.88, -87.63);
  assert.equal(r.status, 'viewonly');
  assert.equal(reads.length, 0);
});

test('a header date that disagrees wins and is logged', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a));
  const { layer } = await harness('gibs-lst', LST, { pixel: [...lstRgb(298.4), 255], timeActual: '2026-08-13' });
  const r = await layer.readoutAt(0, 0);
  assert.equal(r.date, '2026-08-13');
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /layer-time-actual/);
});

test('an unknown colour, a failed fetch and a point off the map each say so', async () => {
  const unknown = await harness('gibs-lst', LST, { pixel: [1, 2, 3, 255] });
  assert.deepEqual(await unknown.layer.readoutAt(0, 0).then((r) => [r.status, r.error]), ['error', 'unknown colour 1,2,3']);
  const failed = await harness('gibs-lst', LST, { fail: 'GIBS tile HTTP 500' });
  assert.deepEqual(await failed.layer.readoutAt(0, 0).then((r) => [r.status, r.error]), ['error', 'GIBS tile HTTP 500']);
  assert.equal((await failed.layer.readoutAt(89, 0)).status, 'outside');
});

test('a disabled layer reads nothing', async () => {
  const { layer, reads } = await harness('gibs-lst', LST, { pixel: [...lstRgb(298.4), 255] });
  layer.disable();
  assert.equal(await layer.readoutAt(0, 0), null);
  assert.equal(reads.length, 0);
});
