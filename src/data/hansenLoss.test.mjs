// src/data/hansenLoss.test.mjs — the forest-loss layer: time bar, drape rebuilds, readout, loud failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHansenLossLayer, createRecolourClient, hansenTileUrl, TILE_FAILURE_LIMIT } from './hansenLoss.js';
import { gibsTileRequest } from './gibsReadout.js';
import { rampColour } from './hansenPixels.js';

function harness({ pixel = [255, 0, 19, 255] } = {}) {
  const providers = [], recolours = [], reads = [], list = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createHansenLossLayer({
    recolourTile: async (url, maxCode) => { recolours.push({ url, maxCode }); return { bitmap: url }; },
    providerFor: (requestImage) => {
      const listeners = [];
      const p = { requestImage, errorEvent: { addEventListener: (fn) => listeners.push(fn) }, fail: (error) => listeners.forEach((fn) => fn({ error })) };
      providers.push(p);
      return p;
    },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: () => {},
    readTilePixel: async (url, px, py) => { reads.push({ url, px, py }); return { rgba: pixel, timeActual: null }; },
  });
  layer.init(viewer);
  return { layer, providers, recolours, reads, list };
}

test('tile URL is the v1.12 dynamic endpoint at 30% canopy; the time bar is offered 2001–2024', () => {
  assert.equal(hansenTileUrl(12, 1331, 2175), 'https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.12/dynamic/12/1331/2175.png?implementation=tcd_30');
  const { layer } = harness();
  assert.deepEqual(layer.getObservedExtent(), { startMs: Date.UTC(2001, 0, 1), endMs: Date.UTC(2024, 11, 31, 23) });
});

test('live draws every loss year; a scrubbed year rebuilds the drape with that cut-off, the same year does not', async () => {
  const { layer, providers, recolours } = harness();
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(providers.length, 1);
  await providers[0].requestImage(1331, 2175, 12);
  assert.deepEqual(recolours.at(-1), { url: hansenTileUrl(12, 1331, 2175), maxCode: 24 });
  assert.equal(layer.getStats().time, '2001–2024');

  await layer.setObservedTime('2010-06-01T00:00:00Z');
  assert.equal(providers.length, 2);
  await providers[1].requestImage(5, 8, 4);
  assert.deepEqual(recolours.at(-1), { url: hansenTileUrl(4, 5, 8), maxCode: 10 });
  assert.equal(layer.getStats().time, '2001–2010');
  await layer.setObservedTime('2010-11-30T00:00:00Z');
  assert.equal(providers.length, 2, 'another instant in 2010 keeps the drape');
});

test('before 2001 the drape is hidden and the gap is named; returning to live shows it again', async () => {
  const { layer, list } = harness();
  layer.enable();
  await layer.update();
  await layer.setObservedTime('1999-03-01T00:00:00Z');
  assert.equal(list.at(-1).show, false);
  assert.match(layer.getStats().error, /no forest loss .*before 2001/);
  assert.equal(layer.getStats().time, null);
  await layer.setObservedTime(null);
  assert.equal(list.at(-1).show, true);
  assert.equal(layer.getStats().error, null);
});

test('readout: a loss pixel reads its year at z12 on 512-px tiles; later-than-shown loss says so; no loss and odd pixels', async () => {
  const lat = -10.0, lon = -63.0;
  const h = harness();
  assert.equal(await h.layer.readoutAt(lat, lon), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const live = await h.layer.readoutAt(lat, lon);
  assert.equal(live.status, 'class');
  assert.equal(live.text, 'Forest loss');
  assert.equal(live.date, '2019');
  const want = gibsTileRequest(hansenTileUrl('{z}', '{x}', '{y}'), 12, lat, lon, 512);
  assert.deepEqual(h.reads.at(-1), want);

  await h.layer.setObservedTime('2010-01-01T00:00:00Z');
  const later = await h.layer.readoutAt(lat, lon);
  assert.equal(later.text, 'Forest loss (after the date shown)');
  assert.equal(later.date, '2019');

  const none = harness({ pixel: [0, 0, 0, 0] });
  none.layer.enable();
  await none.layer.update();
  const n = await none.layer.readoutAt(lat, lon);
  assert.deepEqual([n.status, n.text, n.date], ['class', 'No loss detected', '2001–2024']);

  const odd = harness({ pixel: [255, 9, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  const o = await odd.layer.readoutAt(lat, lon);
  assert.equal(o.status, 'error');
  assert.match(o.error, /255,9,3,255/);
});

test('tile failures: the limit marks the layer failing; a missing OffscreenCanvas is named at once; a stale provider is ignored', async () => {
  const { layer, providers } = harness();
  layer.enable();
  await layer.update();
  for (let i = 0; i < TILE_FAILURE_LIMIT - 1; i++) providers[0].fail(new Error('GFW tile HTTP 503'));
  assert.equal(layer.getStats().error, null, 'below the limit the layer is still healthy');
  providers[0].fail(new Error('GFW tile HTTP 503'));
  assert.equal(layer.getStats().error, 'map tiles failing');

  const h2 = harness();
  h2.layer.enable();
  await h2.layer.update();
  await h2.layer.setObservedTime('2012-01-01T00:00:00Z');
  h2.providers[0].fail(new Error('forest loss needs OffscreenCanvas'));
  assert.equal(h2.layer.getStats().error, null, 'an old provider cannot mark the new one');
  h2.providers[1].fail(new Error('forest loss needs OffscreenCanvas in a worker'));
  assert.match(h2.layer.getStats().error, /OffscreenCanvas/);
});

test('legend: a swatch per sampled year in the ramp colour, plus the source line', () => {
  const { layer } = harness();
  const { legend } = layer.getRowControls();
  const first = legend.find((l) => l.label === '2001');
  assert.equal(first.color, `rgb(${rampColour(2001).join(',')})`);
  assert.ok(legend.find((l) => l.label === '2024'));
  assert.ok(legend.some((l) => /30% canopy/.test(l.label)));
});

test('recolour client: replies resolve by id, errors reject, a crashed worker rejects everything pending and is replaced', async () => {
  const made = [];
  const makeWorker = () => {
    const w = { posted: [], postMessage: (m) => w.posted.push(m) };
    made.push(w);
    return w;
  };
  const recolour = createRecolourClient(makeWorker);
  const a = recolour('u1', 24), b = recolour('u2', 10);
  const [w] = made;
  assert.deepEqual(w.posted.map((m) => [m.url, m.maxCode]), [['u1', 24], ['u2', 10]]);
  w.onmessage({ data: { id: w.posted[1].id, bitmap: 'B2' } });
  w.onmessage({ data: { id: w.posted[0].id, error: 'GFW tile HTTP 404' } });
  assert.equal(await b, 'B2');
  await assert.rejects(a, /GFW tile HTTP 404/);

  const c = recolour('u3', 24);
  w.onerror({ message: 'boom' });
  await assert.rejects(c, /recolour worker failed: boom/);
  const d = recolour('u4', 24);
  assert.equal(made.length, 2, 'a new worker after a crash');
  made[1].onmessage({ data: { id: made[1].posted[0].id, bitmap: 'B4' } });
  assert.equal(await d, 'B4');
});
