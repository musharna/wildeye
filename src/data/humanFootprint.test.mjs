// src/data/humanFootprint.test.mjs — the Human Footprint layer: geographic tile pixels, epochs on the time bar, manifest, drape, readout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  MANIFEST_URL,
  TILE_FAILURE_LIMIT,
  createHumanFootprintLayer,
  decodeFootprint,
  epochAt,
  geoTilePixel,
  validateManifest,
} from './humanFootprint.js';

// the pipeline's palette (pipeline/hfp.py palette()): 50 distinct colours, pale yellow to dark red
const PALETTE = Array.from({ length: 50 }, (_, k) => [255 - k, 255 - 2 * k, 204 - 4 * k]);
const MANIFEST = Object.freeze({
  years: [2000, 2006, 2012, 2018, 2024],
  maxLevel: 4,
  tile: 'data/hfp/{year}/{z}/{x}/{y}.png',
  palette: PALETTE,
  source: { doi: '10.1038/s41597-022-01284-8', licence: 'CC BY 4.0 (figshare article licence)' },
});

function harness({ manifest = MANIFEST, manifestStatus = 200, pixel = [...PALETTE[12], 255], readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createHumanFootprintLayer({
    fetchImpl: async (url) => {
      fetches.push(url);
      return { ok: manifestStatus === 200, status: manifestStatus, json: async () => structuredClone(manifest) };
    },
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
  return { layer, providers, reads, list, stacked, fetches };
}

test('geographic tile pixel: the tile Cesium\'s GeographicTilingScheme puts a point in, and the pixel inside it', () => {
  const scheme = new Cesium.GeographicTilingScheme();
  const points = [[45.3, 10.2], [-33.9, 151.2], [0, 0], [89.99, -179.99], [-89.99, 179.99], [-3.4, -60.0], [51.5, -0.12]];
  for (const z of [0, 1, 4]) {
    for (const [lat, lon] of points) {
      const t = geoTilePixel(lat, lon, z);
      const c = scheme.positionToTileXY(Cesium.Cartographic.fromDegrees(lon, lat), z);
      assert.deepEqual([t.x, t.y], [c.x, c.y], `z${z} ${lat},${lon}`);
      const r = scheme.tileXYToRectangle(t.x, t.y, z);
      const west = Cesium.Math.toDegrees(r.west), north = Cesium.Math.toDegrees(r.north);
      const span = 180 / 2 ** z / 256;
      assert.equal(t.px, Math.floor((lon - west) / span), `px z${z} ${lat},${lon}`);
      assert.equal(t.py, Math.floor((north - lat) / span), `py z${z} ${lat},${lon}`);
    }
  }
  assert.deepEqual(geoTilePixel(-90, 179.9999, 4), { x: 31, y: 15, px: 255, py: 255 }, 'the south-east corner is the last pixel, not a tile past it');
  assert.deepEqual(geoTilePixel(-90, 180, 4), { x: 0, y: 15, px: 0, py: 255 }, '180° is −180°; the pole row is still the last row');
  assert.deepEqual(geoTilePixel(45, 190, 1), geoTilePixel(45, -170, 1), 'longitude wraps');
  assert.equal(geoTilePixel(91, 0, 1), null);
  assert.equal(geoTilePixel(Number.NaN, 0, 1), null);
});

test('epoch at an instant: the snapshot at or before it; live is the latest; before the first there is none', () => {
  const years = MANIFEST.years;
  assert.equal(epochAt(null, years), 2024);
  assert.equal(epochAt('2010-06-01T00:00:00Z', years), 2006);
  assert.equal(epochAt('2006-01-01T00:00:00Z', years), 2006);
  assert.equal(epochAt('2005-12-31T23:59:59Z', years), 2000);
  assert.equal(epochAt('2030-01-01T00:00:00Z', years), 2024);
  assert.equal(epochAt('1999-12-31T23:59:59Z', years), null);
  assert.throws(() => epochAt('not a date', years), /not a date/);
});

test('manifest: the shape the pipeline writes is accepted; each broken field is named', () => {
  assert.equal(validateManifest(MANIFEST), null);
  const broken = [
    [{ ...MANIFEST, years: [] }, /years/],
    [{ ...MANIFEST, years: [2006, 2000] }, /years/],
    [{ ...MANIFEST, maxLevel: 4.5 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/hfp/{z}/{x}/{y}.png' }, /\{year\}/],
    [{ ...MANIFEST, palette: PALETTE.slice(1) }, /palette/],
    [{ ...MANIFEST, palette: [...PALETTE.slice(1), PALETTE[0].slice(0, 2)] }, /palette/],
    [{ ...MANIFEST, palette: [...PALETTE.slice(1), PALETTE[1]] }, /distinct/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateManifest(m) ?? 'accepted', why);
});

test('pixel decode: a palette colour is its bin, transparent is no data, anything else is named', () => {
  for (let k = 0; k < 50; k++) assert.deepEqual(decodeFootprint([...PALETTE[k], 255], PALETTE), { kind: 'value', bin: k });
  assert.deepEqual(decodeFootprint([0, 0, 0, 0], PALETTE), { kind: 'none' });
  for (const odd of [[...PALETTE[3], 254], [1, 2, 3, 255]]) assert.deepEqual(decodeFootprint(odd, PALETTE), { kind: 'unknown', rgba: odd });
});

test('the drape: the manifest is read once; one geographic provider per shown epoch; the time bar steps it at or before', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(layer.getObservedExtent(), null, 'no extent before the manifest is read');
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.deepEqual(layer.getObservedExtent(), { startMs: Date.UTC(2000, 0, 1), endMs: Date.UTC(2024, 11, 31, 23, 59, 59, 999) });
  assert.equal(providers.length, 1);
  const o = providers[0].options;
  assert.equal(o.url, 'data/hfp/2024/{z}/{x}/{y}.png', 'live shows the latest');
  assert.ok(o.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(o.maximumLevel, 4);
  assert.match(o.credit, /Mu et al/);
  assert.equal(list[0].show, false, 'registered off');
  assert.equal(stacked.at(-1).id, 'human-footprint');
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');

  assert.equal(await layer.setObservedTime('2010-03-01T00:00:00Z'), true);
  assert.equal(providers.at(-1).options.url, 'data/hfp/2006/{z}/{x}/{y}.png');
  assert.equal(list.length, 1, 'the old epoch is removed');
  assert.equal(list[0].show, true);
  assert.equal(layer.getStats().time, '2006');
  await layer.setObservedTime('2011-12-01T00:00:00Z');
  assert.equal(providers.length, 2, 'the same epoch keeps its provider');

  await layer.setObservedTime('1995-01-01T00:00:00Z');
  assert.equal(list[0].show, false, 'hidden before 2000');
  assert.match(layer.getStats().error, /no human footprint mapped before 2000 \(shown: 1995-01-01\)/);
  layer.disable();
  layer.enable();
  assert.equal(list[0].show, false, 'enabling does not show a gap');
  await layer.setObservedTime(null);
  assert.equal(layer.getStats().error, null);
  assert.equal(list[0].show, true);
  assert.equal(await layer.setObservedTime('nonsense'), false);
  layer.destroy();
  assert.equal(list.length, 0);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /hfp\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, years: [] } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed hfp\.json: .*years/);
  assert.equal(bad.providers.length, 0);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(0, 0)).status, 'error');
});

test('tile failures: every tile exists, so the limit marks the layer failing and the next update rebuilds it', async () => {
  const { layer, providers } = harness();
  layer.enable();
  await layer.update();
  for (let i = 0; i < TILE_FAILURE_LIMIT - 1; i++) providers[0].fail(new Error('404'));
  assert.equal(layer.getStats().error, null);
  providers[0].fail(new Error('404'));
  assert.equal(layer.getStats().error, 'map tiles failing');
  await layer.update();
  assert.equal(providers.length, 2);
  assert.equal(layer.getStats().error, null);
  for (let i = 0; i < TILE_FAILURE_LIMIT; i++) providers[0].fail(new Error('404'));
  assert.equal(layer.getStats().error, null, 'the old provider no longer counts');
});

test('readout: the bin at the finest level of the shown epoch; no data; a gap before 2000; failures and odd colours are loud', async () => {
  const lat = 45.3, lon = 10.2;
  const h = harness();
  assert.equal(await h.layer.readoutAt(lat, lon), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(lat, lon);
  assert.equal(r.status, 'value');
  assert.equal(r.text, 'Human footprint 12–13 of 50');
  assert.equal(r.date, '2024');
  const t = geoTilePixel(lat, lon, 4);
  assert.deepEqual(h.reads.at(-1), { url: `data/hfp/2024/4/${t.x}/${t.y}.png`, px: t.px, py: t.py });
  await h.layer.setObservedTime('2013-05-01T00:00:00Z');
  await h.layer.readoutAt(lat, lon);
  assert.match(h.reads.at(-1).url, /^data\/hfp\/2012\//, 'the epoch shown is the epoch read');
  await h.layer.setObservedTime('1990-05-01T00:00:00Z');
  const gap = await h.layer.readoutAt(lat, lon);
  assert.equal(gap.status, 'gap');
  assert.equal(gap.observed, '1990-05-01T00:00:00Z');

  const top = harness({ pixel: [...PALETTE[49], 255] });
  top.layer.enable();
  await top.layer.update();
  assert.equal((await top.layer.readoutAt(lat, lon)).text, 'Human footprint 49–50 of 50');

  const sea = harness({ pixel: [0, 0, 0, 0] });
  sea.layer.enable();
  await sea.layer.update();
  const none = await sea.layer.readoutAt(0, -150);
  assert.equal(none.status, 'nodata');
  assert.equal(none.date, '2024');

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  assert.match((await odd.layer.readoutAt(lat, lon)).error, /unrecognised pixel 1,2,3,255/);

  const gone = harness({ readError: Object.assign(new Error('GIBS tile HTTP 404'), { status: 404 }) });
  gone.layer.enable();
  await gone.layer.update();
  const failed = await gone.layer.readoutAt(lat, lon);
  assert.equal(failed.status, 'error', 'every tile is written, so a 404 is a fault, not "outside"');
  assert.match(failed.error, /404/);
});

test('legend: sampled bins in their palette colours, plus the source line', async () => {
  const { layer } = harness();
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, -1).map((e) => e.label), ['0', '10', '20', '30', '40', '50']);
  assert.equal(legend[2].color, `rgb(${PALETTE[20].join(',')})`);
  assert.equal(legend[5].color, `rgb(${PALETTE[49].join(',')})`);
  assert.match(legend.at(-1).label, /Human footprint, 0 wild to 50 most altered \(Mu et al\. 2022\), ~5 km/);
});
