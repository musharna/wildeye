// src/data/wetlands.test.mjs — the GLWD wetlands layer: manifest, decode, drape lifecycle, readout, loud failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MANIFEST_URL, TILE_FAILURE_LIMIT, createWetlandsLayer, decodeWetland, validateWetlandsManifest } from './wetlands.js';
import { geoTilePixel } from './humanFootprint.js';

const FAMILIES = ['Lakes and open water', 'Rivers and riverine wetlands', 'Marshes and swamps', 'Peatlands', 'Coastal wetlands', 'Salt pans', 'Ephemeral wetlands', 'Rice paddies'];
const CLASSES = Array.from({ length: 33 }, (_, i) => ({ id: i + 1, name: `Class ${i + 1}`, rgb: [10 + i, 100 + i, 200 - i], family: FAMILIES[i % 8] }));
CLASSES[27] = { id: 28, name: 'Mangrove', rgb: [118, 42, 131], family: 'Coastal wetlands' };
const MANIFEST = Object.freeze({
  maxLevel: 6,
  tile: 'data/glwd/{z}/{x}/{y}.png',
  dryland: [0, 0, 0],
  noData: [255, 255, 255],
  classes: CLASSES,
  families: FAMILIES.map((name, i) => ({ name, rgb: CLASSES[i].rgb })),
  source: { doi: '10.5194/essd-17-2277-2025', licence: 'CC BY 4.0' },
});

function harness({ manifest = MANIFEST, manifestStatus = 200, pixel = [118, 42, 131, 255], readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createWetlandsLayer({
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

test('manifest: the shape the pipeline writes is accepted; each broken field is named', () => {
  assert.equal(validateWetlandsManifest(MANIFEST), null);
  const broken = [
    [{ ...MANIFEST, maxLevel: 6.5 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/glwd/{z}/{x}.png' }, /\{y\}/],
    [{ ...MANIFEST, classes: CLASSES.slice(1) }, /33 classes/],
    [{ ...MANIFEST, classes: [...CLASSES.slice(0, 32), { ...CLASSES[32], id: 1 }] }, /ids 1–33/],
    [{ ...MANIFEST, classes: [...CLASSES.slice(0, 32), { ...CLASSES[32], rgb: CLASSES[0].rgb }] }, /distinct/],
    [{ ...MANIFEST, classes: [...CLASSES.slice(0, 32), { ...CLASSES[32], rgb: [0, 0, 0] }] }, /distinct/],
    [{ ...MANIFEST, classes: [...CLASSES.slice(0, 32), { ...CLASSES[32], name: '' }] }, /name/],
    [{ ...MANIFEST, dryland: [255, 255, 255] }, /dryland/],
    [{ ...MANIFEST, families: [] }, /families/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateWetlandsManifest(m) ?? 'accepted', why);
});

test('pixel decode: a class colour is its class, transparent black is dryland, transparent white is no data, anything else is named', () => {
  for (const c of CLASSES) assert.deepEqual(decodeWetland([...c.rgb, 255], MANIFEST), { kind: 'class', id: c.id, name: c.name, family: c.family });
  assert.deepEqual(decodeWetland([0, 0, 0, 0], MANIFEST), { kind: 'dryland' });
  assert.deepEqual(decodeWetland([255, 255, 255, 0], MANIFEST), { kind: 'nodata' });
  for (const odd of [[118, 42, 131, 254], [118, 42, 131, 0], [1, 2, 3, 255], [0, 0, 0, 255]]) {
    assert.deepEqual(decodeWetland(odd, MANIFEST), { kind: 'unknown', rgba: odd }, `${odd} is named, not snapped`);
  }
});

test('the drape: the manifest is read once; one geographic provider to level 6, shown only while enabled; not on the time bar', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/glwd.json');
  assert.equal(providers.length, 1);
  const o = providers[0].options;
  assert.equal(o.url, 'data/glwd/{z}/{x}/{y}.png');
  assert.ok(o.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(o.maximumLevel, 6);
  assert.match(o.credit, /Lehner et al/);
  assert.equal(list[0].show, false, 'registered off');
  assert.equal(stacked.at(-1).id, 'wetlands');
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');
  layer.disable();
  assert.equal(list[0].show, false);
  assert.equal(layer.getObservedExtent, undefined, 'not on the time bar');
  assert.equal(layer.setObservedTime, undefined);
  assert.equal(layer.getStats().time, 'GLWD v2');
  layer.destroy();
  assert.equal(list.length, 0);
  assert.equal(stacked.at(-1).imagery, null);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /glwd\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, classes: [] } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed glwd\.json: .*33 classes/);
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

test('readout: the class at level 6 in GLWD\'s words; mostly dryland; no data at sea; failures and odd colours are loud', async () => {
  const lat = 21.9, lon = 89.2;
  const h = harness();
  assert.equal(await h.layer.readoutAt(lat, lon), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(lat, lon);
  assert.equal(r.status, 'class');
  assert.equal(r.text, 'Mangrove');
  assert.equal(r.date, 'GLWD v2');
  const t = geoTilePixel(lat, lon, 6);
  assert.deepEqual(h.reads.at(-1), { url: `data/glwd/6/${t.x}/${t.y}.png`, px: t.px, py: t.py });

  const dry = harness({ pixel: [0, 0, 0, 0] });
  dry.layer.enable();
  await dry.layer.update();
  const d = await dry.layer.readoutAt(23.5, 12.0);
  assert.equal(d.status, 'class');
  assert.equal(d.text, 'Mostly dryland');

  const sea = harness({ pixel: [255, 255, 255, 0] });
  sea.layer.enable();
  await sea.layer.update();
  const s = await sea.layer.readoutAt(0, -150);
  assert.equal(s.status, 'nodata');
  assert.equal(s.date, 'GLWD v2');

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  assert.match((await odd.layer.readoutAt(lat, lon)).error, /unrecognised pixel 1,2,3,255/);

  const gone = harness({ readError: Object.assign(new Error('GIBS tile HTTP 404'), { status: 404 }) });
  gone.layer.enable();
  await gone.layer.update();
  const failed = await gone.layer.readoutAt(lat, lon);
  assert.equal(failed.status, 'error', 'every tile is written, so a 404 is a fault');
  assert.match(failed.error, /404/);
});

test('legend: one swatch per family in its colour, plus the source line', async () => {
  const { layer } = harness();
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, -1).map((e) => e.label), FAMILIES);
  assert.equal(legend[4].color, `rgb(${MANIFEST.families[4].rgb.join(',')})`);
  assert.match(legend.at(-1).label, /Dominant wetland type where a cell is mostly wetland \(GLWD v2, Lehner et al\. 2025\), ~1\.2 km/);
});
