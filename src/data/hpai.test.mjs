// src/data/hpai.test.mjs — polygon contract #2: count classes, bin selection, layer contract + observed time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countClass, binsAt, sumBins, describeCounty, countyEntities, createHpaiLayer, NO_DATA, LIVE_WEEKS } from './hpai.js';

const weeks = [
  { w: '2026-09-11', n: 2, captive: 0, sp: { 'Canada goose': 2 } },
  { w: '2026-08-28', n: 1, captive: 1, sp: { 'Bald eagle': 1 } },
  { w: '2026-04-03', n: 20, captive: 0, sp: { Mallard: 20 } },
];

test('countClass thresholds and none', () => {
  assert.deepEqual([0, 1, 2, 4, 5, 14, 15, 99, NaN].map((n) => countClass(n).key), ['none', 'one', 'few', 'few', 'many', 'many', 'outbreak', 'outbreak', 'none']);
});

test('binsAt: live window excludes old bins; instant picks its 7-day bin; nothing outside', () => {
  const live = binsAt(weeks, null, '2026-09-11');
  assert.deepEqual(live.bins.map((b) => b.w), ['2026-09-11', '2026-08-28']);
  assert.match(live.label, new RegExp(`last ${LIVE_WEEKS} weeks`));
  assert.deepEqual(binsAt(weeks, '2026-09-05T00:00:00Z', '2026-09-11').bins.map((b) => b.w), ['2026-09-11'], 'w−6 d inside');
  assert.deepEqual(binsAt(weeks, '2026-09-04T12:00:00Z', '2026-09-11').bins, [], 'w−7 d is the previous (absent) bin');
  assert.deepEqual(binsAt(weeks, '2026-04-01T00:00:00Z', '2026-09-11').bins.map((b) => b.w), ['2026-04-03']);
  assert.equal(binsAt(weeks, 'garbage', '2026-09-11').bins.length, 0);
  assert.deepEqual(sumBins(live.bins), { n: 3, captive: 1, sp: { 'Canada goose': 2, 'Bald eagle': 1 } });
});

test('describeCounty escapes and carries the sampling-effort caveat', () => {
  const html = describeCounty({ name: '<x>', st: 'GA', n_all: 7 }, { label: 'week ending 2026-09-11' }, { n: 3, captive: 1, sp: { 'Canada goose': 2, 'Bald eagle': 1 } }, { name: 'APHIS', url: 'https://u', licence: 'PD' });
  assert.match(html, /&lt;x&gt; County, GA.*week ending 2026-09-11: 3 detections \(1 in captive wild birds\).*Canada goose: 2 · Bald eagle: 1.*7 detections in this county since 2022.*sampling effort.*https:\/\/u.*PD/s);
});

test('layer: contract, MultiPolygon parts, observed-time recolour, legend counts, records', async () => {
  const poly = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
  const gj = { type: 'FeatureCollection', today: '2026-09-11', newest: '2026-09-09', source: { name: 'APHIS', licence: 'PD', url: 'https://u' }, features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { fips: '13239', name: 'Quitman', st: 'GA', n: 3, n_all: 23, weeks } },
    { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [poly, poly] }, properties: { fips: '22103', name: 'St. Tammany', st: 'LA', n: 1, n_all: 1, weeks: [{ w: '2026-04-03', n: 6, captive: 0, sp: { 'Snow goose': 6 } }] } },
  ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createHpaiLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setObservedTime']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 3, 'one polygon + two MultiPolygon parts');
    assert.deepEqual(l.getStats().classes, { few: 1, none: 1 }, 'live: Quitman 3, St. Tammany only an April bin');
    assert.ok(ds.entities.getById('hpai:22103:1').polygon.material.getValue().color.alpha < 0.3, 'none in scope fades');
    assert.equal(l.setObservedTime('2026-04-01T00:00:00Z'), true);
    assert.deepEqual(l.getStats().classes, { outbreak: 1, many: 1 });
    const legend = l.getRowControls().legend;
    assert.equal(legend.find((i) => i.label === '15+ detections').count, 1);
    assert.equal(legend.find((i) => i.label === NO_DATA.label).count, 0);
    assert.match(legend.at(-1).label, /week of the observed time/);
    assert.equal(l.setObservedTime('bad'), false);
    l.enable();
    assert.equal(l.getAnalystRecords().length, 2);
    assert.equal(l.setObservedTime(null), true);
    assert.equal(l.getAnalystRecords().length, 1, 'St. Tammany has nothing in the live window');
    assert.match(l.getRowControls().legend.at(-1).label, /newest 2026-09-09/);
  } finally { globalThis.fetch = saved; }
});
