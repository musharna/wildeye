// src/data/neon.test.mjs — site-series contract (monthly bins): month selection, site entity, layer contract + observed time + chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthAt, describeSite, siteEntity, createNeonLayer } from './neon.js';

const months = [
  { m: '2026-07', release: 'PROVISIONAL', trapnights: 500, captures: 100, per100: 20.0, individuals: 60, species: { 'Peromyscus maniculatus': 70, 'Microtus oregoni': 30 } },
  { m: '2026-05', release: 'RELEASE-2026', trapnights: 400, captures: 20, per100: 5.0, individuals: 15, species: { 'Microtus oregoni': 20 } },
];

test('monthAt: live = newest bout; instant = its calendar month; none when no bout that month', () => {
  assert.equal(monthAt(months, null).bin.m, '2026-07');
  assert.equal(monthAt(months, '2026-05-31T23:00:00Z').bin.m, '2026-05');
  assert.equal(monthAt(months, '2026-06-15T00:00:00Z').bin, null);
  assert.match(monthAt(months, '2026-06-15T00:00:00Z').label, /no trapping in 2026-06/);
  assert.equal(monthAt(months, 'garbage').bin, null);
  assert.equal(monthAt([], null).bin, null);
});

test('describeSite states per-100, provisional flag, species and the no-ranking caveat', () => {
  const html = describeSite({ name: 'Abby Road NEON', site: 'ABBY', site_type: 'GRADIENT' }, monthAt(months, null), { name: 'NEON', url: 'https://u', licence: 'CC BY 4.0' });
  assert.match(html, /Abby Road NEON.*ABBY.*latest bout, 2026-07: 100 captures in 500 trap-nights = <b>20<\/b> per 100 · 60 tagged individuals · provisional.*Peromyscus maniculatus<\/i>: 70.*own history only.*https:\/\/u.*CC BY 4\.0/s);
  assert.match(describeSite({ name: 'X', site: 'X' }, monthAt(months, '2026-06-01T00:00:00Z')), /no trapping in 2026-06/);
});

test('siteEntity: size from per100, dominant visible species, faded with no bout or all species hidden', () => {
  const f = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.33, 45.76] }, properties: { site: 'ABBY', name: 'Abby', months } };
  const ctx = { visible: {}, species: ['Peromyscus maniculatus', 'Microtus oregoni'], source: {} };
  const live = siteEntity(f, 0, null, ctx);
  assert.equal(live.properties.dominant, 'Peromyscus maniculatus');
  assert.equal(live.properties.per100, 20);
  assert.equal(live.point.color.alpha, 1);
  const may = siteEntity(f, 0, '2026-05-10T00:00:00Z', ctx);
  assert.equal(may.properties.dominant, 'Microtus oregoni');
  assert.ok(may.point.pixelSize < live.point.pixelSize);
  const hidden = siteEntity(f, 0, null, { ...ctx, visible: { 'Peromyscus maniculatus': false, 'Microtus oregoni': false } });
  assert.equal(hidden.properties.active, false);
  assert.ok(hidden.point.color.alpha < 0.3);
  assert.equal(siteEntity(f, 0, '2026-06-01T00:00:00Z', ctx).properties.active, false);
});

test('layer: contract, species order by total captures, observed month, chips, legend, records', async () => {
  const gj = { type: 'FeatureCollection', source: { name: 'NEON', licence: 'CC BY 4.0' }, features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.33, 45.76] }, properties: { site: 'ABBY', name: 'Abby', species: { 'Peromyscus maniculatus': 70, 'Microtus oregoni': 50 }, months } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-72.2, 42.5] }, properties: { site: 'HARV', name: 'Harvard', species: { 'Peromyscus leucopus': 9 }, months: [{ m: '2026-06', release: 'PROVISIONAL', trapnights: 300, captures: 9, per100: 3.0, individuals: 8, species: { 'Peromyscus leucopus': 9 } }] } },
  ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createNeonLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setParams', 'getParams', 'setObservedTime']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 2);
    assert.equal(l.getStats().active, 2, 'live: every site shows its latest bout');
    let rc = l.getRowControls();
    assert.deepEqual(rc.chips.map((c) => c.label), ['PEROMYSCUS MANICULATUS', 'MICROTUS OREGONI', 'PEROMYSCUS LEUCOPUS']);
    assert.equal(rc.legend.find((i) => i.label === 'Peromyscus maniculatus').count, 1);
    assert.equal(l.setObservedTime('2026-06-15T00:00:00Z'), true);
    assert.equal(l.getStats().active, 1, 'only HARV trapped in June');
    assert.match(l.getRowControls().legend.at(-1).label, /month of the observed time/);
    l.setObservedTime('2026-05-15T00:00:00Z');
    assert.equal(ds.entities.getById('neon:0').properties.dominant.getValue(), 'Microtus oregoni');
    assert.equal(l.setParams({ 'Microtus oregoni': false }), true);
    assert.equal(l.getStats().active, 0, 'May at ABBY was voles only');
    assert.equal(l.setParams({ 'Microtus oregoni': false }), false);
    assert.equal(l.setObservedTime('bad'), false);
    assert.equal(l.setObservedTime(null), true);
    l.enable();
    const recs = l.getAnalystRecords();
    assert.equal(recs.length, 2);
    assert.equal(recs[0].per100, 20);
  } finally { globalThis.fetch = saved; }
});
