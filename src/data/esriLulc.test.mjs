// src/data/esriLulc.test.mjs — the 10 m land cover layer: year on the time bar, tile boxes, readout, loud failures, wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  CLASSES, FIRST_YEAR, LAST_YEAR, MAX_LEVEL, NONE_TEXT, SERVICE, TILE_FAILURE_LIMIT,
  createEsriLulcLayer, decodeLulcPixel, lulcTileUrl, tileBox, yearFor,
} from './esriLulc.js';
import { tilePixel } from './gibsReadout.js';
import { LAYER_GROUPS } from './layerGroups.js';
import { LAYER_STATE_REGISTRY, REGISTERED_LAYER_IDS } from './layerState.js';

const HALF = Math.PI * 6378137;

function harness({ pixel = [53, 130, 33, 255], fail = null } = {}) {
  const providers = [], loads = [], reads = [], list = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; } } };
  const layer = createEsriLulcLayer({
    providerFor: (requestImage) => {
      const listeners = [];
      const p = { requestImage, errorEvent: { addEventListener: (fn) => listeners.push(fn) }, fail: (error) => listeners.forEach((fn) => fn({ error })) };
      providers.push(p);
      return p;
    },
    loadImage: (provider, url) => { loads.push(url); return url; },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: () => {},
    readTilePixel: async (url, px, py) => {
      reads.push({ url, px, py });
      if (fail) throw fail;
      return { rgba: pixel, timeActual: null };
    },
  });
  layer.init(viewer);
  return { layer, providers, loads, reads, list };
}

test('the year drawn: newest when live or later, the scrubbed year inside 2017–2025, none before 2017', () => {
  assert.equal(yearFor(null), LAST_YEAR);
  assert.equal(yearFor('2019-12-31T23:00:00Z'), 2019);
  assert.equal(yearFor('2017-01-01T00:00:00Z'), FIRST_YEAR);
  assert.equal(yearFor('2016-12-31T23:59:59Z'), null);
  assert.equal(yearFor('2026-10-26T12:00:00Z'), 2025);
  assert.throws(() => yearFor('not a date'), /land cover: not a date: not a date/);
});

test('tile boxes are web-mercator metres as Cesium cuts them, and hold the point tilePixel puts in them', () => {
  assert.deepEqual(tileBox(0, 0, 0), [-HALF, -HALF, HALF, HALF]);
  assert.deepEqual(tileBox(1, 1, 0), [0, 0, HALF, HALF], 'row 0 is the north row');
  assert.deepEqual(tileBox(1, 0, 1), [-HALF, -HALF, 0, 0]);
  for (const [lat, lon] of [[41.6, -93.6], [-3.1, -60.0], [64.8, 25.5], [-33.9, 151.2]]) {
    const t = tilePixel(lat, lon, MAX_LEVEL, 256);
    const [w, s, e, n] = tileBox(MAX_LEVEL, t.x, t.y);
    const x = (lon * HALF) / 180;
    const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 6378137;
    assert.ok(w <= x && x < e && s < y && y <= n, `${lat},${lon} inside its tile`);
    // and at the pixel tilePixel names
    const px = Math.floor(((x - w) / (e - w)) * 256), py = Math.floor(((n - y) / (n - s)) * 256);
    assert.deepEqual([px, py], [t.px, t.py]);
  }
});

test('tile URL: exportImage of the box for the year at 1 July, PNG32 in the service default renderer, 256 px', () => {
  const u = new URL(lulcTileUrl(3, 2, 5, 2021));
  assert.equal(`${u.origin}${u.pathname}`, `${SERVICE}/exportImage`);
  const q = u.searchParams;
  assert.equal(q.get('bbox'), tileBox(3, 2, 5).join(','));
  assert.equal(q.get('bboxSR'), '3857');
  assert.equal(q.get('imageSR'), '3857');
  assert.equal(q.get('size'), '256,256');
  assert.equal(q.get('format'), 'png32');
  assert.equal(q.get('time'), String(Date.UTC(2021, 6, 1)));
  assert.equal(q.get('renderingRule'), null, 'the default is the cartographic renderer; a JSON rule cannot pass through Cesium (next test)');
  assert.equal(q.get('f'), 'image');
  assert.notEqual(lulcTileUrl(3, 2, 5, 2017), lulcTileUrl(3, 2, 5, 2021), 'another year is another request');
});

// Cesium's Resource turns every %7B/%7D back into a brace (its URL-template placeholders), and the service answers a raw
// brace with a 400 that has no CORS header, so the browser drew no tile at all (qa-esri-lulc, 2026-10-26).
test('tile URL reaches the service as written: through Cesium Resource every parameter survives and no raw brace is sent', () => {
  for (const url of [lulcTileUrl(3, 2, 5, 2021), lulcTileUrl(MAX_LEVEL, 4000, 6000, FIRST_YEAR)]) {
    const sent = new Cesium.Resource({ url }).url;
    const want = [...new URL(url).searchParams].sort();
    assert.deepEqual([...new URL(sent).searchParams].sort(), want);
    assert.ok(want.length >= 7);
    assert.doesNotMatch(sent, /[{}]/);
  }
});

test('pixels: each legend colour is its class, transparent is none, any other colour or partial alpha is named', () => {
  assert.equal(CLASSES.length, 9);
  for (const c of CLASSES) assert.equal(decodeLulcPixel([...c.rgb, 255]).label, c.label);
  assert.equal(decodeLulcPixel([0, 0, 0, 0]).kind, 'none');
  assert.equal(decodeLulcPixel([53, 130, 34, 255]).kind, 'unknown');
  assert.equal(decodeLulcPixel([53, 130, 33, 128]).kind, 'unknown', 'a blended pixel is not a class');
  assert.equal(decodeLulcPixel([255, 255, 255, 255]).kind, 'unknown', "the legend's No Data white is never drawn opaque");
});

test('time bar: live draws 2025; a scrubbed year rebuilds the drape for that year, the same year does not; extent 2017–2025', async () => {
  const { layer, providers, loads } = harness();
  assert.deepEqual(layer.getObservedExtent(), { startMs: Date.UTC(2017, 0, 1), endMs: Date.UTC(2025, 11, 31, 23) });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(providers.length, 1);
  providers[0].requestImage(5, 9, 4);
  assert.equal(loads.at(-1), lulcTileUrl(4, 5, 9, 2025));
  assert.equal(layer.getStats().time, '2025');

  await layer.setObservedTime('2019-06-01T00:00:00Z');
  assert.equal(providers.length, 2);
  providers[1].requestImage(5, 9, 4);
  assert.equal(loads.at(-1), lulcTileUrl(4, 5, 9, 2019));
  assert.equal(layer.getStats().time, '2019');
  await layer.setObservedTime('2019-11-30T00:00:00Z');
  assert.equal(providers.length, 2, 'another instant in 2019 keeps the drape');
  await layer.setObservedTime('2026-02-01T00:00:00Z');
  assert.equal(providers.length, 3);
  providers[2].requestImage(5, 9, 4);
  assert.equal(loads.at(-1), lulcTileUrl(4, 5, 9, 2025), 'after the last year: the newest map');
});

test('before 2017 the drape is hidden and the gap is named; live shows it again', async () => {
  const { layer, list } = harness();
  layer.enable();
  await layer.update();
  await layer.setObservedTime('2012-03-01T00:00:00Z');
  assert.equal(list.at(-1).show, false);
  assert.match(layer.getStats().error, /no land cover is mapped before 2017 \(shown: 2012-03-01\)/);
  assert.equal(layer.getStats().time, null);
  await layer.setObservedTime(null);
  assert.equal(list.at(-1).show, true);
  assert.equal(layer.getStats().error, null);
});

test('readout: the class from the level-14 tile of the year shown; none, odd colour, failed fetch, off and before 2017', async () => {
  const lat = 41.6, lon = -93.6;
  const h = harness();
  assert.equal(await h.layer.readoutAt(lat, lon), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(lat, lon);
  assert.deepEqual([r.status, r.text, r.date], ['class', 'Trees', '2025']);
  const t = tilePixel(lat, lon, MAX_LEVEL, 256);
  assert.deepEqual(h.reads.at(-1), { url: lulcTileUrl(MAX_LEVEL, t.x, t.y, 2025), px: t.px, py: t.py });
  await h.layer.setObservedTime('2018-05-01T00:00:00Z');
  await h.layer.readoutAt(lat, lon);
  assert.equal(h.reads.at(-1).url, lulcTileUrl(MAX_LEVEL, t.x, t.y, 2018));
  await h.layer.setObservedTime('2010-05-01T00:00:00Z');
  assert.equal((await h.layer.readoutAt(lat, lon)).status, 'outside');

  const none = harness({ pixel: [0, 0, 0, 0] });
  none.layer.enable();
  await none.layer.update();
  const n = await none.layer.readoutAt(lat, lon);
  assert.deepEqual([n.status, n.text, n.date], ['class', NONE_TEXT, '2025']);

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  const o = await odd.layer.readoutAt(lat, lon);
  assert.equal(o.status, 'error');
  assert.match(o.error, /unrecognised pixel 1,2,3,255/);

  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a);
  try {
    const bad = harness({ fail: new Error('GIBS tile HTTP 500') });
    bad.layer.enable();
    await bad.layer.update();
    const b = await bad.layer.readoutAt(lat, lon);
    assert.deepEqual([b.status, b.error], ['error', 'GIBS tile HTTP 500']);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1, 'a failed readout is logged once');
  assert.equal((await h.layer.readoutAt(91, 0)).status, 'outside');
});

test('tile failures: the limit marks the layer failing, an update retries with a fresh provider; a stale provider is ignored', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a);
  try {
    const { layer, providers } = harness();
    layer.enable();
    await layer.update();
    for (let i = 0; i < TILE_FAILURE_LIMIT - 1; i++) providers[0].fail(new Error('HTTP 503'));
    assert.equal(layer.getStats().error, null, 'below the limit the layer is still healthy');
    providers[0].fail(new Error('HTTP 503'));
    assert.equal(layer.getStats().error, 'map tiles failing');
    await layer.update();
    assert.equal(providers.length, 2, 'a fresh provider is the retry');
    assert.equal(layer.getStats().error, null);
    for (let i = 0; i < TILE_FAILURE_LIMIT; i++) providers[0].fail(new Error('HTTP 503'));
    assert.equal(layer.getStats().error, null, 'the old provider cannot mark the new one');
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
});

test('legend: a swatch per class in the service colours, then the note with the years, sampling and credit', () => {
  const { layer } = harness();
  const { legend } = layer.getRowControls();
  assert.equal(legend.length, CLASSES.length + 1);
  assert.deepEqual(legend[1], { label: 'Trees', color: 'rgb(53,130,33)', count: null });
  const note = legend.at(-1).label;
  assert.match(note, /2017–2025/);
  assert.match(note, /each pixel is one 10 m sample, not the most common class/);
  assert.match(note, /Impact Observatory, Microsoft, Esri; data CC BY 4\.0/);
});

test('wired in main.js: registered, a drape, read on click, on the time bar; Habitats beside MODIS land cover; token lu', () => {
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /import \{ esriLulcLayer \} from '\.\/data\/esriLulc\.js';/);
  assert.match(main, /dataManager\.register\(esriLulcLayer\);/);
  const list = (re) => main.match(re)?.[1].split(',').map((s) => s.trim());
  const drapes = list(/const drapeLayers = \[([^\]]+)\];/);
  const reads = list(/const readGibsLayers = \(\{ lat, lon \}\) => \[\n\s*\.\.\.\[([^\]]+)\]/);
  const observed = list(/const observedLayers = \[([^\]]+)\];/);
  assert.ok(drapes?.includes('hansenLossLayer') && reads?.includes('hansenLossLayer') && observed?.includes('hansenLossLayer'), 'positive control: the three lists were found');
  assert.ok(drapes.includes('esriLulcLayer'), 'a drape, so turning it on turns another drape off');
  assert.ok(reads.includes('esriLulcLayer'), 'read on click');
  assert.ok(observed.includes('esriLulcLayer'), 'one map a year, on the time bar');
  const habitats = LAYER_GROUPS.find((g) => g.id === 'habitats').layers;
  assert.equal(habitats.indexOf('esri-lulc'), habitats.indexOf('gibs-landcover') + 1);
  assert.ok(REGISTERED_LAYER_IDS.includes('esri-lulc'));
  assert.equal(LAYER_STATE_REGISTRY.find((e) => e.id === 'esri-lulc')?.token, 'lu');
});
