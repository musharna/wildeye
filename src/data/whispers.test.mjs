// src/data/whispers.test.mjs — polygon contract #4: event classes, sums, info box event list, layer contract + observed time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventClass, sumBins, describeCounty, countyEntities, createWhispersLayer, NO_DATA } from './whispers.js';
import { binsAt } from './hpai.js';

const weeks = [
  { w: '2026-09-11', n: 1, affected: 40, sp: { 'Canada Goose': 1 } },
  { w: '2026-08-28', n: 2, affected: 3, sp: { 'Bald Eagle': 1, 'Black Vulture': 1 } },
  { w: '2026-04-03', n: 5, affected: 1002, sp: { Mallard: 5 } },
];
const events = [
  { id: 1, start: '2026-09-10', end: '2026-09-10', affected: 40, species: ['Canada Goose'], diagnoses: ['Pending'], complete: false },
  { id: 2, start: '2026-08-25', end: '2026-08-27', affected: 2, species: ['Bald Eagle'], diagnoses: ['Highly Pathogenic Avian Influenza (AI virus H5N1)'], complete: true },
  { id: 3, start: '2026-08-23', end: '2026-08-23', affected: 1, species: ['Black Vulture'], diagnoses: ['Trauma'], complete: true },
  { id: 4, start: '2026-04-01', end: '2026-04-02', affected: 1002, species: ['Mallard'], diagnoses: ['Undetermined'], complete: true },
];

test('eventClass thresholds and sums', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99, NaN].map((n) => eventClass(n).key), ['none', 'one', 'two', 'several', 'several', 'cluster', 'cluster', 'none']);
  assert.deepEqual(sumBins(weeks.slice(0, 2)), { n: 3, affected: 43, sp: { 'Canada Goose': 1, 'Bald Eagle': 1, 'Black Vulture': 1 } });
});

test('describeCounty lists only the events in scope, newest first, with the provisional caveat', () => {
  const p = { name: 'Inyo', st: 'CA', n: 8, events, weeks };
  const live = binsAt(weeks, null, '2026-09-11');
  const html = describeCounty(p, live, sumBins(live.bins), { name: 'WHISPers', url: 'https://u', licence: 'PD' });
  assert.match(html, /Inyo County, CA.*last 8 weeks to 2026-09-11: 3 events, ~43 animals.*2026-09-10: Canada Goose · 40 affected · Pending · open.*2026-08-25–2026-08-27: Bald Eagle · 2 affected · Highly Pathogenic.*Black Vulture.*8 events in this county.*lab results.*https:\/\/u.*PD/s);
  assert.doesNotMatch(html, /Mallard/, 'April event is outside the live window');
  const april = binsAt(weeks, '2026-04-01T12:00:00Z', '2026-09-11');
  assert.match(describeCounty(p, april, sumBins(april.bins)), /week ending 2026-04-03: 5 events, ~1,002 animals.*Mallard · 1002 affected/s);
});

test('layer: contract, observed-time recolour, legend counts, records', async () => {
  const poly = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
  const gj = { type: 'FeatureCollection', today: '2026-09-11', newest: '2026-09-10', source: { name: 'WHISPers', licence: 'PD', url: 'https://u' }, features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { fips: '06027', name: 'Inyo', st: 'CA', n: 8, events, weeks } },
    { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [poly, poly] }, properties: { fips: '06029', name: 'Kern', st: 'CA', n: 1, events: [events[3]], weeks: [weeks[2]] } },
  ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createWhispersLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setObservedTime']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 3);
    assert.deepEqual(l.getStats().classes, { several: 1, none: 1 });
    assert.equal(ds.entities.getById('whispers:06029:1').polygon.material.getValue().color.alpha, 0.35, 'no events → visible grey (0.15 read as bare imagery)');
    assert.equal(l.setObservedTime('2026-04-01T00:00:00Z'), true);
    assert.deepEqual(l.getStats().classes, { cluster: 2 });
    const legend = l.getRowControls().legend;
    assert.equal(legend.find((i) => i.label === '5+ events').count, 2);
    assert.equal(legend.find((i) => i.label === NO_DATA.label).count, 0);
    assert.match(legend.at(-1).label, /week of the observed time/);
    assert.equal(l.setObservedTime('bad'), false);
    l.enable();
    assert.equal(l.getAnalystRecords().length, 2);
    assert.equal(l.setObservedTime(null), true);
    assert.equal(l.getAnalystRecords().length, 1);
    assert.equal(l.getAnalystRecords()[0].affected, 43);
    assert.match(l.getRowControls().legend.at(-1).label, /newest 2026-09-10/);
  } finally { globalThis.fetch = saved; }
});
