// src/data/rasterDrape.test.mjs — manifest selection + layer contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickProduct, createRasterDrapeLayer, crwBleachingLayer, oisstLayer, legendItems, restackDrapes, _drapeStackForTest, frameAtOrBefore, setStackedImagery, setDrapeSplit, drapeStackState, onDrapeRestack } from './rasterDrape.js';

test('pickProduct: finds by id, null when absent or malformed', () => {
  const m = { products: [{ id: 'a', png: 'x' }, { id: 'b' }] };
  assert.deepEqual(pickProduct(m, 'a'), { id: 'a', png: 'x' });
  assert.equal(pickProduct(m, 'zzz'), null);
  assert.equal(pickProduct({}, 'a'), null);
  assert.equal(pickProduct(null, 'a'), null);
});

test('raster drape: contract and ids', () => {
  for (const l of [crwBleachingLayer, oisstLayer, createRasterDrapeLayer({ id: 't', name: 't', icon: 'x', source: 's' })]) {
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getRowControls']) assert.equal(typeof l[k], 'function');
    assert.equal(l.getStats().count, 0);
  }
  assert.equal(crwBleachingLayer.id, 'crw-bleaching');
  assert.equal(oisstLayer.id, 'oisst');
});

test('legendItems: discrete classes hide the masked class, ramps give min/mid/max swatches, plain text falls back', () => {
  const cls = legendItems({ classes: [{ label: 'none', rgb: [4, 35, 51], hidden: true }, { label: 'watch', rgb: [82, 59, 154] }] });
  assert.deepEqual(cls, [{ label: 'watch', color: 'rgb(82,59,154)', count: null }]);
  const ramp = legendItems({ ramp: { min: -2, max: 32, unit: '°C', stops: [[0, 0, 0], [100, 100, 100], [255, 255, 255]] } });
  assert.equal(ramp.length, 3);
  assert.equal(ramp[0].label, '-2°C'); assert.equal(ramp[0].color, 'rgb(0,0,0)');
  assert.equal(ramp[2].label, '32°C'); assert.equal(ramp[2].color, 'rgb(255,255,255)');
  assert.deepEqual(legendItems({ legend: 'txt' }), [{ label: 'txt', color: 'transparent', count: null }]);
  assert.deepEqual(legendItems(null), []);
});

test('restackDrapes: order is by zrank regardless of which drape arrived last', () => {
  const stack = _drapeStackForTest(); stack.clear();
  const layers = [];
  const imageryLayers = { add: (l) => layers.push(l), remove: (l) => { const i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); }, contains: (l) => layers.includes(l) };
  const base = { id: 'base' }; imageryLayers.add(base);
  const alerts = { id: 'alerts' }, sst = { id: 'sst' };
  stack.set('crw-bleaching', { layer: alerts, zrank: 90 }); imageryLayers.add(alerts);   // alerts fetched first…
  stack.set('oisst', { layer: sst, zrank: 10 }); imageryLayers.add(sst);                 // …SST arrives later, would sit on top
  assert.deepEqual(restackDrapes(imageryLayers), ['oisst', 'crw-bleaching']);
  assert.deepEqual(layers.map((l) => l.id), ['base', 'sst', 'alerts']);
  stack.clear();
});

test('frameAtOrBefore: nearest earlier acquisition, null when none or bad input', () => {
  const h = [{ time: '2026-09-09T12:00:00Z', png: 'a' }, { time: '2026-09-11T12:00:00Z', png: 'c' }, { time: '2026-09-10T12:00:00Z', png: 'b' }];
  assert.equal(frameAtOrBefore(h, '2026-09-10T18:00:00Z').png, 'b');
  assert.equal(frameAtOrBefore(h, '2026-09-11T12:00:00Z').png, 'c');
  assert.equal(frameAtOrBefore(h, '2026-09-01T00:00:00Z'), null);
  assert.equal(frameAtOrBefore(h, 'garbage'), null);
  assert.equal(frameAtOrBefore([], '2026-09-10T00:00:00Z'), null);
});

test('drape: setObservedTime picks an archived frame and update() keeps it; null returns to latest', async () => {
  const stack = _drapeStackForTest(); stack.clear();
  const layers = [];
  const viewer = { imageryLayers: { add: (l) => layers.push(l), remove: (l) => { const i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); }, contains: (l) => layers.includes(l) } };
  const entry = { id: 'x', png: 'data/rasters/x.png', time: '2026-09-11T12:00:00Z', bounds: { west: -1, south: -1, east: 1, north: 1 },
    history: [{ time: '2026-09-10T12:00:00Z', png: 'data/rasters/x/20260910T120000Z.png' }, { time: '2026-09-11T12:00:00Z', png: 'data/rasters/x/20260911T120000Z.png' }] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ products: [entry] }) });
  const urls = [];
  try {
    const l = createRasterDrapeLayer({ id: 'x', name: 'x', icon: 'i', source: 's',
      providerFor: async (url) => { urls.push(url.split('?')[0]); return { url }; }, imageryLayerFor: (p) => ({ p, show: true }) });
    l.init(viewer); l.enable();
    assert.equal(await l.update(), true);
    assert.equal(l.getStats().time, '2026-09-11T12:00:00Z');
    assert.equal(await l.setObservedTime('2026-09-10T20:00:00Z'), true);
    assert.equal(l.getStats().time, '2026-09-10T12:00:00Z');
    assert.equal(await l.update(), true, 'poll keeps the selected frame');
    assert.equal(l.getStats().time, '2026-09-10T12:00:00Z');
    assert.equal(await l.setObservedTime('2026-09-01T00:00:00Z'), true, 'before every acquisition: hidden, not faked');
    assert.equal(layers.at(-1).show, false);
    assert.match(l.getStats().error, /no x acquisition at or before 2026-09-01/);
    assert.equal(await l.update(), true);
    assert.equal(layers.at(-1).show, false, 'poll keeps the gap');
    assert.equal(await l.setObservedTime(null), true);
    assert.equal(layers.at(-1).show, true);
    assert.equal(l.getStats().error, null);
    assert.equal(l.getStats().time, '2026-09-11T12:00:00Z');
    assert.deepEqual(urls, ['data/rasters/x.png', 'data/rasters/x/20260910T120000Z.png', 'data/rasters/x.png']);
    assert.equal(l.getStats().frames, 2);
    l.destroy(viewer);
  } finally { globalThis.fetch = saved; stack.clear(); }
});

const fakeImagery = () => {
  const on = [];
  return {
    on,
    add(l) { on.push(l); },
    remove(l) { const i = on.indexOf(l); if (i >= 0) on.splice(i, 1); return i >= 0; },
    contains(l) { return on.includes(l); },
  };
};

test('a drape split survives the drape rebuilding its ImageryLayer; other drapes draw full-globe', () => {
  const il = fakeImagery();
  const a1 = { id: 'a1' }, a2 = { id: 'a2' }, b = { id: 'b' };
  setStackedImagery(il, 'split-a', a1, 10);
  setStackedImagery(il, 'split-b', b, 20);
  setDrapeSplit(il, 'split-a', -1);
  assert.equal(a1.splitDirection, -1);
  assert.equal(b.splitDirection, 0);
  // the layer rebuilds (new date / new frame): the new ImageryLayer must carry the split too
  setStackedImagery(il, 'split-a', a2, 10);
  assert.equal(a2.splitDirection, -1);
  assert.deepEqual(drapeStackState(il).filter((e) => e.id.startsWith('split-')), [
    { id: 'split-a', splitDirection: -1, onGlobe: true },
    { id: 'split-b', splitDirection: 0, onGlobe: true },
  ]);
  setDrapeSplit(il, 'split-a', 0);
  assert.equal(a2.splitDirection, 0);
  setStackedImagery(il, 'split-a', null);
  setStackedImagery(il, 'split-b', null);
});

test("restack listeners run after the caller's synchronous bookkeeping", async () => {
  const il = fakeImagery();
  let shown = 'old';
  const seen = [];
  const off = onDrapeRestack(() => seen.push(shown));
  setStackedImagery(il, 'listen-a', { id: 'x' }, 10);
  shown = 'new'; // gibsLayer.js sets _shownDate right AFTER stack(); rasterDrape sets _shown after restackDrapes
  await Promise.resolve();
  assert.deepEqual(seen, ['new']);
  off();
  setStackedImagery(il, 'listen-a', null);
  await Promise.resolve();
  assert.deepEqual(seen, ['new']);
});
