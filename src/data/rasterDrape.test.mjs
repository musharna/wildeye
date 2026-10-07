// src/data/rasterDrape.test.mjs — manifest selection + layer contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickProduct, createRasterDrapeLayer, crwBleachingLayer, oisstLayer, legendItems, restackDrapes, _drapeStackForTest, frameAtOrBefore, setStackedImagery, setDrapeSplit, drapeStackState, onDrapeRestack, rampValue, rampPosition, rampReadoutText, drapePixel, cmemsZoocLayer } from './rasterDrape.js';

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

test('stats name the frame being fetched until it lands, and the frame on the globe meanwhile', async () => {
  // The compare label read stats.time only, so while a scrubbed frame downloaded it showed the old date
  // with nothing to say a change was on its way (stage 2 review minor).
  const stack = _drapeStackForTest(); stack.clear();
  const viewer = { imageryLayers: fakeImagery() };
  const entry = { id: 'y', png: 'data/rasters/y.png', time: '2026-09-11T12:00:00Z', bounds: { west: -1, south: -1, east: 1, north: 1 },
    history: [{ time: '2026-09-10T12:00:00Z', png: 'data/rasters/y/a.png' }, { time: '2026-09-11T12:00:00Z', png: 'data/rasters/y/b.png' }] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ products: [entry] }) });
  let release = null;
  try {
    const l = createRasterDrapeLayer({ id: 'y', name: 'y', icon: 'i', source: 's',
      providerFor: (url) => (url.includes('/a.png') ? new Promise((r) => { release = () => r({ url }); }) : Promise.resolve({ url })),
      imageryLayerFor: (p) => ({ p, show: true }) });
    l.init(viewer); l.enable();
    await l.update();
    assert.equal(l.getStats().loadingTime, null); // nothing in flight
    const pending = l.setObservedTime('2026-09-10T20:00:00Z');
    assert.equal(l.getStats().time, '2026-09-11T12:00:00Z'); // still drawing the old frame
    assert.equal(l.getStats().loadingTime, '2026-09-10T12:00:00Z');
    release();
    assert.equal(await pending, true);
    assert.equal(l.getStats().time, '2026-09-10T12:00:00Z');
    assert.equal(l.getStats().loadingTime, null);
    l.destroy(viewer);
  } finally { globalThis.fetch = saved; stack.clear(); }
});

// The cmems-zooc ramp as in pipeline/rasters.json; the colours below were rendered by pipeline/raster.py ramp_rgba
// with this ramp (2026-10-07), so these tests check the browser against the pipeline, not against a JS copy of it.
const ZOOC = { min: 0.05, max: 5, unit: ' mmol C/m³', log: true,
  stops: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]] };
const RENDERED = [[0.069, [65, 24, 99]], [0.2, [54, 95, 139]], [0.5, [33, 145, 140]], [0.54, [37, 149, 137]],
  [1.3, [84, 191, 105]], [3.14, [189, 219, 62]], [4.9, [250, 230, 38]]];

test('rampValue: log spaces the ramp in decades, linear in units; ends are min and max', () => {
  assert.equal(rampValue(0, ZOOC), 0.05);
  assert.ok(Math.abs(rampValue(0.5, ZOOC) - 0.5) < 1e-12, 'middle of 0.05..5 on a log ramp is the geometric mean');
  assert.ok(Math.abs(rampValue(0.25, ZOOC) - 0.05 * 10 ** 0.5) < 1e-12);
  assert.ok(Math.abs(rampValue(1, ZOOC) - 5) < 1e-12);
  // positive control: the same ramp without `log` is linear
  assert.equal(rampValue(0.5, { ...ZOOC, log: false }), 2.525);
  assert.equal(rampValue(0.25, { min: 195, max: 395 }), 245);
});

test('rampPosition: a colour the pipeline rendered lies on the ramp; a colour off it is null, never snapped', () => {
  assert.equal(rampPosition([68, 1, 84], ZOOC.stops), 0);
  assert.equal(rampPosition([253, 231, 37], ZOOC.stops), 1);
  assert.equal(rampPosition([33, 145, 140], ZOOC.stops), 0.5);
  assert.equal(rampPosition([59, 82, 139], ZOOC.stops), 0.25);
  for (const [v, rgb] of RENDERED) {
    const back = rampValue(rampPosition(rgb, ZOOC.stops), ZOOC);
    // one 8-bit colour step is at most 1.9% of the value on this ramp (measured over 200,001 values)
    assert.ok(Math.abs(back - v) / v <= 0.019, `${rgb} read back as ${back}, rendered from ${v}`);
  }
  assert.equal(rampPosition([68, 0, 83], ZOOC.stops), 0, 'a rounding step past the first stop is the first stop, not before it');
  assert.equal(rampPosition([255, 0, 0], ZOOC.stops), null, 'pure red is nowhere on viridis');
  assert.equal(rampPosition([33, 145, 143], ZOOC.stops), null, 'three levels off the middle stop is off the ramp');
  assert.notEqual(rampPosition([33, 145, 141], ZOOC.stops), null, 'one level off is rounding, still on the ramp');
});

test('rampReadoutText: two significant figures and the unit; the clamped ends read as bounds', () => {
  assert.deepEqual(rampReadoutText([37, 149, 137], ZOOC), { kind: 'value', text: '0.54 mmol C/m³' });
  assert.deepEqual(rampReadoutText([84, 191, 105], ZOOC), { kind: 'value', text: '1.3 mmol C/m³' });
  assert.deepEqual(rampReadoutText([65, 24, 99], ZOOC), { kind: 'value', text: '0.069 mmol C/m³' });
  assert.deepEqual(rampReadoutText([68, 1, 84], ZOOC), { kind: 'value', text: '≤ 0.05 mmol C/m³' });
  assert.deepEqual(rampReadoutText([253, 231, 37], ZOOC), { kind: 'value', text: '≥ 5 mmol C/m³' });
  assert.deepEqual(rampReadoutText([255, 0, 0], ZOOC), { kind: 'unknown', rgb: [255, 0, 0] });
});

test('drapePixel: the pixel the drape draws at a point, from the manifest bounds; off the image is null', () => {
  const b = { west: -180, south: -80, east: 180, north: 90 };
  assert.deepEqual(drapePixel(90, -180, b, 1440, 681), { px: 0, py: 0 });
  assert.deepEqual(drapePixel(-80, 179.99, b, 1440, 681), { px: 1439, py: 680 }, 'the south edge falls in the last row');
  assert.deepEqual(drapePixel(-80, 180, b, 1440, 681), { px: 0, py: 680 }, '180°E is -180°, the west edge of column 0');
  assert.deepEqual(drapePixel(0, 0, b, 1440, 681), { px: 720, py: Math.floor((90 / 170) * 681) });
  assert.deepEqual(drapePixel(10, 190, b, 1440, 681), drapePixel(10, -170, b, 1440, 681), 'longitude wraps');
  assert.equal(drapePixel(-80.01, 0, b, 1440, 681), null, 'south of the image');
  assert.equal(drapePixel(Number.NaN, 0, b, 1440, 681), null);
  assert.deepEqual(drapePixel(0.5, 0.5, { west: -1, south: -1, east: 1, north: 1 }, 2, 2), { px: 1, py: 0 });
  assert.equal(drapePixel(0, 5, { west: -1, south: -1, east: 1, north: 1 }, 2, 2), null, 'east of a regional image');
  assert.deepEqual(drapePixel(0, 1, { west: -1, south: -1, east: 1, north: 1 }, 2, 2), { px: 1, py: 1 }, 'its east edge is its last column');
});

test('legendItems: a log ramp labels its middle swatch with the value the ramp has there, at 2 significant figures', () => {
  const items = legendItems({ ramp: ZOOC });
  assert.deepEqual(items.map((i) => i.label), ['0.05 mmol C/m³', '0.5 mmol C/m³', '5 mmol C/m³']);
  assert.deepEqual(items.map((i) => i.color), ['rgb(68,1,84)', 'rgb(33,145,140)', 'rgb(253,231,37)']);
  // geometric mean of 0.05 and 4 is 0.4472…: printed as the 2-figure value, not 16 digits
  assert.equal(legendItems({ ramp: { ...ZOOC, max: 4 } })[1].label, '0.45 mmol C/m³');
  // chlor-a's existing log ramp keeps its label; linear middles are untouched (pH prints all its digits)
  assert.equal(legendItems({ ramp: { min: 0.05, max: 20, unit: ' mg/m³', log: true, stops: ZOOC.stops } })[1].label, '1 mg/m³');
  assert.equal(legendItems({ ramp: { min: 7.95, max: 8.16, unit: '', stops: ZOOC.stops } })[1].label, '8.055');
});

/** An RGBA image `w`×`h` filled with `fill`, with `cells` = { 'px,py': [r,g,b,a] } overridden. */
function rgbaImage(w, h, fill, cells = {}) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
  for (const [k, c] of Object.entries(cells)) { const [x, y] = k.split(',').map(Number); data.set(c, (y * w + x) * 4); }
  return { width: w, height: h, data };
}

test('readoutAt: the shown frame\'s pixel under the point, inverted through the ramp; land, gap, off-ramp and failures named', async () => {
  const stack = _drapeStackForTest(); stack.clear();
  const viewer = { imageryLayers: fakeImagery() };
  const entry = { id: 'z', png: 'data/rasters/z.png', time: '2026-10-07T00:00:00Z', width: 4, height: 2, ramp: ZOOC,
    bounds: { west: -180, south: -90, east: 180, north: 90 },
    history: [{ time: '2026-10-06T00:00:00Z', png: 'data/rasters/z/a.png' }, { time: '2026-10-07T00:00:00Z', png: 'data/rasters/z/b.png' }] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ products: [entry] }) });
  const images = {
    // every pixel a different reading: (2,1) under the point is 0.54, its neighbours read ≥ 5
    'data/rasters/z.png': rgbaImage(4, 2, [253, 231, 37, 255], { '2,1': [37, 149, 137, 255], '0,0': [0, 0, 0, 0], '3,1': [255, 0, 0, 255] }),
    'data/rasters/z/a.png': rgbaImage(4, 2, [84, 191, 105, 255]),
  };
  const read = [];
  let failNext = false;
  try {
    const l = createRasterDrapeLayer({ id: 'z', name: 'Zed', icon: '🦐', source: 's', readout: true,
      providerFor: async (url) => ({ url }), imageryLayerFor: (p) => ({ p, show: true }),
      decodeImage: async (url) => {
        read.push(url);
        if (failNext) { failNext = false; throw new Error('HTTP 503'); }
        return images[url.split('?')[0]];
      } });
    assert.equal(await l.readoutAt(0, 0), null, 'off: no row');
    l.init(viewer); l.enable();
    assert.deepEqual(await l.readoutAt(0, 0), { id: 'z', name: 'Zed', icon: '🦐', status: 'error', text: null, date: null, error: 'z not loaded' });
    await l.update();
    const row = (status, extra) => ({ id: 'z', name: 'Zed', icon: '🦐', status, text: null, date: '2026-10-07', ...extra });
    assert.deepEqual(await l.readoutAt(-45, 0), row('value', { text: '0.54 mmol C/m³' }));
    assert.deepEqual(await l.readoutAt(45, -100), row('nodata'), 'transparent = land');
    assert.deepEqual(await l.readoutAt(-45, 170), row('error', { error: 'colour 255,0,0 is not on the ramp' }));
    assert.equal(read.length, 1, 'one decode per frame');
    // the time bar picks the archived frame: the readout reads that frame, under that date
    await l.setObservedTime('2026-10-06T12:00:00Z');
    assert.deepEqual(await l.readoutAt(-45, 0), { ...row('value', { text: '1.3 mmol C/m³' }), date: '2026-10-06' });
    await l.setObservedTime('2026-09-01T00:00:00Z');
    assert.deepEqual(await l.readoutAt(-45, 0), { id: 'z', name: 'Zed', icon: '🦐', status: 'gap', text: null, date: null, observed: '2026-09-01T00:00:00Z' });
    await l.setObservedTime(null);
    // a failed read is reported and not cached: the next click reads again
    failNext = true;
    images['data/rasters/z.png'] = rgbaImage(4, 2, [65, 24, 99, 255]);
    l.destroy(viewer); l.init(viewer); l.enable(); await l.update();
    assert.deepEqual(await l.readoutAt(-45, 0), row('error', { error: 'HTTP 503' }));
    assert.deepEqual(await l.readoutAt(-45, 0), row('value', { text: '0.069 mmol C/m³' }));
    // an image whose size differs from the manifest is refused by name
    images['data/rasters/z.png'] = rgbaImage(2, 2, [65, 24, 99, 255]);
    entry.time = '2026-10-08T00:00:00Z'; // the next day's frame, a new image to read
    l.destroy(viewer); l.init(viewer); l.enable(); await l.update();
    const before = read.length;
    assert.deepEqual(await l.readoutAt(-45, 0), { ...row('error', { error: 'z image is 2×2, the manifest says 4×2' }), date: '2026-10-08' });
    assert.deepEqual(await l.readoutAt(-45, 0), { ...row('error', { error: 'z image is 2×2, the manifest says 4×2' }), date: '2026-10-08' }, 'a refused image is read again, not kept');
    assert.equal(read.length, before + 2, 'each click decoded it again');
    l.destroy(viewer);
    // a drape not built with readout has no readoutAt (only cmems-zooc opts in)
    assert.equal(createRasterDrapeLayer({ id: 'q', name: 'q', icon: 'i', source: 's' }).readoutAt, undefined);
    assert.equal(typeof cmemsZoocLayer.readoutAt, 'function');
    assert.equal(cmemsZoocLayer.id, 'cmems-zooc');
  } finally { globalThis.fetch = saved; stack.clear(); }
});
