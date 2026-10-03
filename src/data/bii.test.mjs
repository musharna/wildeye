// src/data/bii.test.mjs — the Biodiversity Intactness Index layer: manifest, snapshots on the time bar, drape, readout, legend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MANIFEST_URL, TILE_FAILURE_LIMIT, binText, createBiiLayer, validateManifest } from './bii.js';
import { geoTilePixel } from './humanFootprint.js';

// the pipeline's palette shape (pipeline/bii.py palette()): 100 distinct colours, pale to dark green
const PALETTE = Array.from({ length: 100 }, (_, k) => [255 - 2 * k, 255 - k, 229 - 2 * k]);
const MANIFEST = Object.freeze({
  years: [2000, 2005, 2010, 2015, 2020],
  maxLevel: 4,
  tile: 'data/bii/{year}/{z}/{x}/{y}.png',
  palette: PALETTE,
  source: { doi: '10.5519/k33reyb6', licence: 'CC BY-NC-SA 4.0' },
});

function harness({ manifest = MANIFEST, manifestStatus = 200, pixel = [...PALETTE[64], 255], readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createBiiLayer({
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
  assert.equal(validateManifest(MANIFEST), null);
  const broken = [
    [{ ...MANIFEST, years: [] }, /years/],
    [{ ...MANIFEST, years: [2005, 2000] }, /years/],
    [{ ...MANIFEST, maxLevel: -1 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/bii/{z}/{x}/{y}.png' }, /\{year\}/],
    [{ ...MANIFEST, palette: PALETTE.slice(50) }, /palette is not 100/],
    [{ ...MANIFEST, palette: [...PALETTE, [1, 2, 3]] }, /palette is not 100/],
    [{ ...MANIFEST, palette: [...PALETTE.slice(1), [0, 0, 256]] }, /palette is not 100/],
    [{ ...MANIFEST, palette: [...PALETTE.slice(1), PALETTE[1]] }, /distinct/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateManifest(m) ?? 'accepted', why);
});

test('bin text: one percent wide, the last bin closed at 100', () => {
  assert.equal(binText(0), 'BII 0–1%');
  assert.equal(binText(64), 'BII 64–65%');
  assert.equal(binText(99), 'BII 99–100%');
});

test('the drape: the manifest is read once; one geographic provider per shown snapshot; the time bar steps it at or before', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(layer.getObservedExtent(), null, 'no extent before the manifest is read');
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/bii.json');
  assert.deepEqual(layer.getObservedExtent(), { startMs: Date.UTC(2000, 0, 1), endMs: Date.UTC(2020, 11, 31, 23, 59, 59, 999) });
  assert.equal(providers.length, 1);
  const o = providers[0].options;
  assert.equal(o.url, 'data/bii/2020/{z}/{x}/{y}.png', 'live shows the latest');
  assert.ok(o.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(o.maximumLevel, 4);
  assert.match(o.credit, /NHM v2\.1\.1/);
  assert.equal(list[0].show, false, 'registered off');
  assert.deepEqual([stacked.at(-1).id, stacked.at(-1).zrank], ['bii', 21]);
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');

  assert.equal(await layer.setObservedTime('2009-03-01T00:00:00Z'), true);
  assert.equal(providers.at(-1).options.url, 'data/bii/2005/{z}/{x}/{y}.png');
  assert.equal(list.length, 1, 'the old snapshot is removed');
  assert.equal(list[0].show, true);
  assert.equal(layer.getStats().time, '2005');
  await layer.setObservedTime('2005-01-01T00:00:00Z');
  assert.equal(providers.length, 2, 'the same snapshot keeps its provider');
  await layer.setObservedTime('2015-01-01T00:00:00Z');
  assert.equal(providers.at(-1).options.url, 'data/bii/2015/{z}/{x}/{y}.png', 'a snapshot year shows itself');

  await layer.setObservedTime('1999-12-31T00:00:00Z');
  assert.equal(list[0].show, false, 'hidden before 2000');
  assert.match(layer.getStats().error, /no biodiversity intactness mapped before 2000 \(shown: 1999-12-31\)/);
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
  assert.match(gone.layer.getStats().error, /bii\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, palette: PALETTE.slice(50) } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed bii\.json: palette/);
  assert.equal(bad.providers.length, 0);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(0, 0)).status, 'error');
  const good = harness();
  assert.equal(await good.layer.update(), true, 'positive control: the same harness with the pipeline shape draws');
  assert.equal(good.providers.length, 1);
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

test('readout: the bin at the finest level of the shown snapshot; no data; a gap before 2000; failures and odd colours are loud', async () => {
  const lat = -10.0417, lon = -63.0417;
  const h = harness();
  assert.equal(await h.layer.readoutAt(lat, lon), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(lat, lon);
  assert.equal(r.status, 'value');
  assert.equal(r.text, 'BII 64–65%');
  assert.equal(r.date, '2020');
  const t = geoTilePixel(lat, lon, 4);
  assert.deepEqual(h.reads.at(-1), { url: `data/bii/2020/4/${t.x}/${t.y}.png`, px: t.px, py: t.py });
  await h.layer.setObservedTime('2012-05-01T00:00:00Z');
  await h.layer.readoutAt(lat, lon);
  assert.match(h.reads.at(-1).url, /^data\/bii\/2010\//, 'the snapshot shown is the snapshot read');
  await h.layer.setObservedTime('1990-05-01T00:00:00Z');
  const gap = await h.layer.readoutAt(lat, lon);
  assert.equal(gap.status, 'gap');
  assert.equal(gap.observed, '1990-05-01T00:00:00Z');

  const top = harness({ pixel: [...PALETTE[99], 255] });
  top.layer.enable();
  await top.layer.update();
  assert.equal((await top.layer.readoutAt(lat, lon)).text, 'BII 99–100%');

  const sea = harness({ pixel: [0, 0, 0, 0] });
  sea.layer.enable();
  await sea.layer.update();
  const none = await sea.layer.readoutAt(0.0417, -149.9583);
  assert.equal(none.status, 'nodata');
  assert.equal(none.date, '2020');

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  assert.match((await odd.layer.readoutAt(lat, lon)).error, /unrecognised pixel 1,2,3,255/);

  const gone = harness({ readError: Object.assign(new Error('tile HTTP 404'), { status: 404 }) });
  gone.layer.enable();
  await gone.layer.update();
  const failed = await gone.layer.readoutAt(lat, lon);
  assert.equal(failed.status, 'error', 'every tile is written, so a 404 is a fault, not "outside"');
  assert.match(failed.error, /404/);
});

test('legend: sampled bins in their palette colours, plus what the index is', async () => {
  const { layer } = harness();
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, -1).map((e) => e.label), ['0%', '20%', '40%', '60%', '80%', '100%']);
  assert.equal(legend[0].color, `rgb(${PALETTE[0].join(',')})`);
  assert.equal(legend[3].color, `rgb(${PALETTE[60].join(',')})`);
  assert.equal(legend[5].color, `rgb(${PALETTE[99].join(',')})`);
  assert.match(legend.at(-1).label, /modelled share of the original species abundance remaining.*NHM v2\.1\.1\), ~10 km/);
});
