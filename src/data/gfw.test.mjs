// src/data/gfw.test.mjs — polygon contract #3: density classes, bin selection, per-week normalisation, layer contract + observed time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { densityClass, binsAt, density, describeCountry, countryEntities, createGfwLayer, NO_DATA, LIVE_WEEKS } from './gfw.js';

const weeks = [
  { w: '2026-09-12', n: 10, ha: 1 },
  { w: '2026-09-05', n: 1000, ha: 100 },
  { w: '2026-08-29', n: 2000, ha: 200 },
  { w: '2026-06-06', n: 50000, ha: 5000 },
];
const area = 10000; // km² → 1 unit of 10,000 km²

test('densityClass thresholds and none', () => {
  assert.deepEqual([0, 1, 2.5, 49, 50, 249, 250, 9999, NaN, null].map((d) => densityClass(d).key), ['none', 'trace', 'low', 'low', 'high', 'high', 'severe', 'severe', 'none', 'none']);
});

test('binsAt + density: live averages over the window span, a single week is not averaged', () => {
  const live = binsAt(weeks, null, '2026-09-12');
  assert.deepEqual(live.bins.map((b) => b.w), ['2026-09-12', '2026-09-05', '2026-08-29']);
  assert.equal(live.span, LIVE_WEEKS);
  assert.equal(density(live.bins, live.span, area), 301 / 4, 'ha per 10,000 km² per week');
  const wk = binsAt(weeks, '2026-09-01T00:00:00Z', '2026-09-12');
  assert.deepEqual(wk.bins.map((b) => b.w), ['2026-09-05']);
  assert.equal(density(wk.bins, wk.span, area), 100);
  assert.deepEqual(binsAt(weeks, '2026-07-15T00:00:00Z', '2026-09-12').bins, []);
  assert.equal(binsAt(weeks, 'garbage', '2026-09-12').bins.length, 0);
  assert.equal(density([], 1, 0), null);
});

test('describeCountry states totals, per-week density and the disturbance caveat', () => {
  const scope = binsAt(weeks, '2026-09-01T00:00:00Z', '2026-09-12');
  const html = describeCountry({ name: 'Brazil <x>', iso: 'BRA', area_km2: 8500000, n: 12345 }, scope, 100, { name: 'GFW', url: 'https://u', licence: 'CC BY 4.0' });
  assert.match(html, /Brazil &lt;x&gt;.*BRA.*week ending 2026-09-05: 1,000 alerts over ~100 ha = <b>100<\/b> ha per 10,000 km² per week.*8,500,000 km².*12,345 alerts.*not confirmed deforestation.*https:\/\/u.*CC BY 4\.0/s);
});

test('layer: contract, MultiPolygon parts, observed-time recolour, legend counts, records', async () => {
  const poly = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
  const gj = { type: 'FeatureCollection', today: '2026-09-12', source: { name: 'GFW', licence: 'CC BY 4.0', url: 'https://u', version: 'v20260912' }, features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { iso: 'AAA', name: 'A', area_km2: area, n: 53010, weeks } },
    { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [poly, poly] }, properties: { iso: 'BBB', name: 'B', area_km2: area, n: 5, weeks: [{ w: '2026-06-06', n: 5, ha: 0.5 }] } },
  ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createGfwLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setObservedTime']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 3);
    assert.deepEqual(l.getStats().classes, { high: 1, none: 1 }, 'live: A = 75.25/week, B has only a June week');
    assert.equal(ds.entities.getById('gfw:BBB:1').polygon.material.getValue().color.alpha, 0.35, 'no alerts → visible grey (0.12 read as bare imagery)');
    assert.equal(l.setObservedTime('2026-06-03T00:00:00Z'), true);
    assert.deepEqual(l.getStats().classes, { severe: 1, trace: 1 });
    const legend = l.getRowControls().legend;
    assert.equal(legend.find((i) => /^> 250/.test(i.label)).count, 1);
    assert.equal(legend.find((i) => i.label === NO_DATA.label).count, 0);
    assert.match(legend.at(-1).label, /week of the observed time/);
    assert.equal(l.setObservedTime('bad'), false);
    l.enable();
    assert.equal(l.getAnalystRecords().length, 2);
    assert.equal(l.setObservedTime(null), true);
    assert.equal(l.getAnalystRecords().length, 1);
    assert.match(l.getRowControls().legend.at(-1).label, /v20260912/);
  } finally { globalThis.fetch = saved; }
});
