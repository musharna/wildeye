import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGibsLayer } from './gibsLayer.js';
import { createTilePixelReader } from './gibsReadout.js';
import { decodePng } from './pngDecode.js';

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

test("an undated layer reads its count dated with the data's year; GIBS's 2899-12-31 placeholder is not a date", async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a));
  const AM = JSON.parse(readFileSync(new URL('./fixtures/gibs-sedac.json', import.meta.url))).layers['gibs-amphibians'];
  const twelve = AM.decode.find((e) => e[3] === 12).slice(0, 3);
  const { layer, reads } = await harness('gibs-amphibians', AM, { pixel: [...twelve, 255], timeActual: '2899-12-31T00:00:00Z' });
  const r = await layer.readoutAt(-3, -60);
  assert.match(reads[0].url, /\/Amphibian_Richness_All_Species_2013\/default\/GoogleMapsCompatible_Level7\/7\/\d+\/\d+\.png$/);
  assert.deepEqual([r.status, r.text, r.date], ['value', '12', '2013']);
  assert.equal(errors.length, 0);
});

test('a disabled layer reads nothing', async () => {
  const { layer, reads } = await harness('gibs-lst', LST, { pixel: [...lstRgb(298.4), 255] });
  layer.disable();
  assert.equal(await layer.readoutAt(0, 0), null);
  assert.equal(reads.length, 0);
});

test("a disturbance click on a corrupt tile says so and the next click fetches a fresh one; a real tile reads its class", async () => {
  // real tiles (fixtures/README.md); the corrupt one has the observed shape: text bytes in an empty tile's last row
  const png = (n) => decodePng(new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url))));
  const ocean = await png('opera-dist-2025-ocean-8-128-106.png');
  const corrupt = { ...ocean, data: Uint8Array.from(ocean.data) };
  corrupt.data.set(new TextEncoder().encode('AHTSE Retile'), corrupt.data.length - 12);
  const DIST = JSON.parse(readFileSync(new URL('./fixtures/gibs-disturbance.json', import.meta.url))).layers['gibs-disturbance'];
  const served = [corrupt, ocean];
  const make = (entry) => {
    const layer = createGibsLayer({
      id: 'gibs-disturbance', name: 'd', icon: '·', source: 'NASA GIBS',
      fetchJson: async () => ({ layers: { 'gibs-disturbance': entry } }),
      providerFor: (url) => ({ url, errorEvent: { addEventListener() {} } }),
      imageryLayerFor: (provider) => ({ provider, show: true }),
      stack: () => {},
      // the tile at 0°, 30°W's level-12 pixel is the last row's end when served as this 1-tile stand-in
      readTilePixel: ((read) => (url, px, py, opts) => read(url, 255, 255, opts))(createTilePixelReader({
        fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), blob: async () => served.shift() }),
        decodeImage: async (image) => image,
      })),
    });
    layer.init({ imageryLayers: { add() {}, remove: () => true, contains: () => false } });
    return layer;
  };
  const layer = make(DIST);
  await layer.update();
  layer.enable();
  const first = await layer.readoutAt(0, -30);
  assert.deepEqual([first.status, first.error], ['error', 'GIBS sent a corrupt tile; click again for a fresh copy']);
  assert.equal((await layer.readoutAt(0, -30)).status, 'nodata');
  // without the flag the same corrupt tile is only an unknown colour: the check is what names it
  served.push(corrupt);
  const plain = make({ ...DIST, discardForeignTiles: undefined });
  await plain.update();
  plain.enable();
  assert.match((await plain.readoutAt(0, -30)).error, /^unknown colour /);
  // a real land tile reads its class through the same check
  served.push(await png('opera-dist-2025-land-9-173-151.png'));
  const land = make(DIST);
  await land.update();
  land.enable();
  const r = await land.readoutAt(50.2, -73.3);
  assert.equal(r.status, 'class');
});
